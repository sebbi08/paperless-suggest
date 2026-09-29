import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { serve } from '@hono/node-server'
import { createApp } from './api/app'
import { createAuth } from './api/auth'
import { ConfigError, loadConfig, type Config } from './config'
import { createLlmClient } from './llm/client'
import { createPaperlessClient } from './paperless/client'
import { InboxTagError, loadVocabulary } from './paperless/vocabulary'
import { openDb } from './store/db'
import { SuggestionStore } from './store/suggestions'
import { createSuggester } from './suggest/suggester'
import { Worker } from './worker/worker'

async function main(): Promise<void> {
  let config: Config
  try {
    config = loadConfig(process.env)
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message)
      process.exit(1)
    }
    throw e
  }

  mkdirSync(config.dataDir, { recursive: true })
  const db = openDb(path.join(config.dataDir, 'paperless-suggest.sqlite'))
  const store = new SuggestionStore(db)
  const paperless = createPaperlessClient({ baseUrl: config.paperlessUrl, token: config.paperlessToken })
  const llm = createLlmClient({ baseUrl: config.llmBaseUrl, model: config.llmModel })
  const suggester = createSuggester({
    llm,
    maxContentChars: config.maxContentChars,
    matchThreshold: config.newNameMatchThreshold,
  })
  const worker = new Worker({
    paperless,
    llm,
    suggester,
    store,
    inboxTag: config.inboxTag,
    pollIntervalSec: config.pollIntervalSec,
  })

  try {
    const vocab = await loadVocabulary(paperless, config.inboxTag)
    console.info(`Paperless reachable; inbox tag id ${vocab.inboxTagId}`)
  } catch (e) {
    if (e instanceof InboxTagError) {
      console.error(e.message)
      process.exit(1)
    }
    console.warn(`Paperless not reachable at startup, will keep retrying: ${(e as Error).message}`)
  }

  let secret = store.getMeta('session_secret')
  if (!secret) {
    secret = randomBytes(32).toString('hex')
    store.setMeta('session_secret', secret)
  }
  const auth = createAuth({ password: config.appPassword, disabled: config.authDisabled, secret })

  const webDir = path.join(import.meta.dirname, 'web')
  const app = createApp({
    paperless,
    store,
    worker,
    auth,
    inboxTag: config.inboxTag,
    staticDir: existsSync(webDir) ? webDir : null,
  })

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.info(`Listening on http://0.0.0.0:${info.port}`)
  })
  worker.start()

  const shutdown = () => {
    worker.stop()
    server.close(() => {
      db.close()
      process.exit(0)
    })
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

import { Hono } from 'hono'
import { applySuggestion, ApplyRequestSchema } from '../apply/apply'
import { PaperlessError, type PaperlessClient } from '../paperless/client'
import { loadVocabulary, selectableTags } from '../paperless/vocabulary'
import type { SuggestionStore } from '../store/suggestions'
import type { Worker } from '../worker/worker'
import type { Auth } from './auth'
import { serveSpa } from './static'
import type { DocumentDetail, StatusResponse } from './types'

export interface AppDeps {
  paperless: PaperlessClient
  store: SuggestionStore
  worker: Pick<Worker, 'status' | 'wake'>
  auth: Auth
  inboxTag: string | null
  staticDir: string | null
}

const parseId = (v: string | undefined): number | null =>
  v !== undefined && /^\d+$/.test(v) && Number(v) > 0 ? Number(v) : null

export function createApp(deps: AppDeps): Hono {
  const { paperless, store, worker, auth } = deps
  const app = new Hono()

  app.onError((err, c) => {
    if (err instanceof PaperlessError) return c.json({ error: err.message }, 502)
    console.error(err)
    return c.json({ error: err.message || 'Internal error' }, 500)
  })

  // Registered before the auth middleware, so they stay reachable without a session.
  app.post('/api/login', (c) => auth.login(c))
  app.post('/api/logout', (c) => auth.logout(c))
  app.use('/api/*', auth.middleware)

  app.get('/api/status', (c) => {
    const body: StatusResponse = { ...worker.status(), counts: store.counts() }
    return c.json(body)
  })

  app.get('/api/queue/next', (c) => {
    const after = c.req.query('after')
    const afterId = after === undefined ? undefined : parseId(after)
    if (afterId === null) return c.json({ error: 'invalid after' }, 400)
    return c.json({ documentId: store.nextReviewable(afterId) })
  })

  app.get('/api/documents/:id', async (c) => {
    const id = parseId(c.req.param('id'))
    if (id === null) return c.json({ error: 'invalid id' }, 400)
    const [doc, vocab] = await Promise.all([paperless.getDocument(id), loadVocabulary(paperless, deps.inboxTag)])
    const body: DocumentDetail = {
      document: {
        id: doc.id,
        title: doc.title,
        created: doc.created,
        content: doc.content,
        correspondentId: doc.correspondent,
        tagIds: doc.tags,
        modified: doc.modified,
        added: doc.added,
      },
      suggestion: store.get(id),
      vocabulary: {
        inboxTagId: vocab.inboxTagId,
        tags: selectableTags(vocab).map(({ id: tagId, name }) => ({ id: tagId, name })),
        correspondents: vocab.correspondents.map(({ id: cId, name }) => ({ id: cId, name })),
      },
    }
    return c.json(body)
  })

  for (const kind of ['thumb', 'preview'] as const) {
    app.get(`/api/documents/:id/${kind}`, async (c) => {
      const id = parseId(c.req.param('id'))
      if (id === null) return c.json({ error: 'invalid id' }, 400)
      const res = await paperless.fetchFile(id, kind)
      return new Response(res.body, {
        headers: {
          'Content-Type': res.headers.get('content-type') ?? 'application/octet-stream',
          'Cache-Control': 'private, max-age=300',
          'X-Content-Type-Options': 'nosniff',
        },
      })
    })
  }

  app.post('/api/documents/:id/apply', async (c) => {
    const id = parseId(c.req.param('id'))
    if (id === null) return c.json({ error: 'invalid id' }, 400)
    const parsed = ApplyRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }, 400)
    }
    const vocab = await loadVocabulary(paperless, deps.inboxTag)
    const result = await applySuggestion({ paperless, store }, id, parsed.data, vocab)
    if (result.kind === 'applied') return c.json({ status: 'applied' })
    const { kind: _kind, ...conflict } = result
    return c.json(conflict, 409)
  })

  app.post('/api/documents/:id/regenerate', (c) => {
    const id = parseId(c.req.param('id'))
    if (id === null) return c.json({ error: 'invalid id' }, 400)
    if (!store.requestRegenerate(id)) return c.json({ error: 'document is not in the queue' }, 404)
    worker.wake()
    return c.json({ status: 'pending' })
  })

  app.all('/api/*', (c) => c.json({ error: 'not found' }, 404))

  if (deps.staticDir) app.get('*', serveSpa(deps.staticDir))

  return app
}

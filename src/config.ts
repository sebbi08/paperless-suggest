import { z } from 'zod'

export class ConfigError extends Error {
  override name = 'ConfigError'
}

export interface Config {
  paperlessUrl: string
  paperlessToken: string
  llmBaseUrl: string
  llmModel: string | null
  inboxTag: string | null
  appPassword: string | null
  authDisabled: boolean
  pollIntervalSec: number
  llmConcurrency: number
  /** null leaves LM Studio's load settings alone */
  llmContextLength: number | null
  /** Unload the model in LM Studio once the queue is empty */
  llmUnloadWhenIdle: boolean
  maxContentChars: number
  newNameMatchThreshold: number
  dataDir: string
  port: number
}

const EnvSchema = z.object({
  PAPERLESS_URL: z.string().url(),
  PAPERLESS_TOKEN: z.string().min(1),
  LLM_BASE_URL: z.string().url(),
  LLM_MODEL: z.string().optional(),
  INBOX_TAG: z.string().optional(),
  APP_PASSWORD: z.string().optional(),
  AUTH_DISABLED: z.enum(['true', 'false', '1', '0']).optional(),
  POLL_INTERVAL: z.coerce.number().int().positive().default(300),
  LLM_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(1),
  LLM_CONTEXT_LENGTH: z.coerce.number().int().min(2048).optional(),
  LLM_UNLOAD_WHEN_IDLE: z.enum(['true', 'false', '1', '0']).optional(),
  MAX_CONTENT_CHARS: z.coerce.number().int().positive().default(6000),
  NEW_NAME_MATCH_THRESHOLD: z.coerce.number().min(0).max(1).default(0.85),
  DATA_DIR: z.string().default('/data'),
  PORT: z.coerce.number().int().positive().default(3000),
})

const stripSlash = (url: string) => url.replace(/\/+$/, '')

export function loadConfig(
  env: Record<string, string | undefined>,
  opts: { requireAuth?: boolean } = {},
): Config {
  const requireAuth = opts.requireAuth ?? true
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ''),
  )
  const parsed = EnvSchema.safeParse(cleaned)
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
    throw new ConfigError(`Invalid configuration:\n${lines.join('\n')}`)
  }
  const e = parsed.data
  const authDisabled = e.AUTH_DISABLED === 'true' || e.AUTH_DISABLED === '1'
  if (requireAuth && !authDisabled && !e.APP_PASSWORD) {
    throw new ConfigError('Invalid configuration:\nAPP_PASSWORD: required unless AUTH_DISABLED=true')
  }
  return {
    paperlessUrl: stripSlash(e.PAPERLESS_URL),
    paperlessToken: e.PAPERLESS_TOKEN,
    llmBaseUrl: stripSlash(e.LLM_BASE_URL),
    llmModel: e.LLM_MODEL ?? null,
    inboxTag: e.INBOX_TAG ?? null,
    appPassword: e.APP_PASSWORD ?? null,
    authDisabled,
    pollIntervalSec: e.POLL_INTERVAL,
    llmConcurrency: e.LLM_CONCURRENCY,
    llmContextLength: e.LLM_CONTEXT_LENGTH ?? null,
    llmUnloadWhenIdle: e.LLM_UNLOAD_WHEN_IDLE === 'true' || e.LLM_UNLOAD_WHEN_IDLE === '1',
    maxContentChars: e.MAX_CONTENT_CHARS,
    newNameMatchThreshold: e.NEW_NAME_MATCH_THRESHOLD,
    dataDir: e.DATA_DIR,
    port: e.PORT,
  }
}

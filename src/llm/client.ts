import OpenAI from 'openai'

export interface LlmRequest {
  system: string
  user: string
  schemaName: string
  schema: Record<string, unknown>
  model?: string
}

export interface LlmResponse {
  content: string
  model: string
}

export type LlmHealth = { ok: true; model: string } | { ok: false; error: string }

export interface LlmClient {
  complete(req: LlmRequest): Promise<LlmResponse>
  health(): Promise<LlmHealth>
}

export class LlmError extends Error {
  override name = 'LlmError'
}

interface LmStudioModel {
  id: string
  type?: string
  state?: string
}

interface LmStudioModelV1 {
  key: string
  loaded_instances?: { id: string; config?: { context_length?: number } }[]
}

export function createLlmClient(opts: {
  baseUrl: string
  model: string | null
  /** When set, the model is (re)loaded in LM Studio with at least this context length. */
  contextLength?: number | null
  timeoutMs?: number
}): LlmClient {
  const baseUrl = opts.baseUrl.replace(/\/+$/, '')
  const root = baseUrl.replace(/\/v1$/, '')
  const openai = new OpenAI({
    baseURL: baseUrl,
    apiKey: 'lm-studio',
    timeout: opts.timeoutMs ?? 300_000,
    maxRetries: 0,
  })
  let loadedModel: string | null = null

  async function findLoadedModel(): Promise<string | null> {
    const res = await fetch(`${root}/api/v0/models`, { signal: AbortSignal.timeout(5_000) })
    if (!res.ok) return null
    const body = (await res.json()) as { data?: LmStudioModel[] }
    return body.data?.find((m) => m.state === 'loaded' && m.type !== 'embeddings')?.id ?? null
  }

  async function lmStudio(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${root}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      // loading a large model can take a while
      signal: AbortSignal.timeout(path.endsWith('/load') ? 300_000 : 30_000),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status} ${text.slice(0, 200)}`)
    return text ? JSON.parse(text) : null
  }

  /** Reloads `model` unless an instance with a large enough context is already loaded. */
  async function ensureContextLength(model: string, contextLength: number): Promise<void> {
    const list = (await lmStudio('GET', '/api/v1/models')) as { models?: LmStudioModelV1[] }
    const instances = list.models?.find((m) => m.key === model)?.loaded_instances ?? []
    if (instances.some((i) => (i.config?.context_length ?? 0) >= contextLength)) return
    for (const i of instances) await lmStudio('POST', '/api/v1/models/unload', { instance_id: i.id })
    await lmStudio('POST', '/api/v1/models/load', { model, context_length: contextLength })
  }

  return {
    async health() {
      try {
        await openai.models.list()
      } catch (e) {
        return { ok: false, error: `LM Studio unreachable: ${(e as Error).message}` }
      }
      let model = opts.model
      if (!model) {
        loadedModel = await findLoadedModel().catch(() => null)
        if (!loadedModel) return { ok: false, error: 'No model loaded in LM Studio and LLM_MODEL is not set' }
        model = loadedModel
      }
      if (opts.contextLength) {
        try {
          await ensureContextLength(model, opts.contextLength)
        } catch (e) {
          return { ok: false, error: `Could not load ${model} with context length ${opts.contextLength}: ${(e as Error).message}` }
        }
      }
      return { ok: true, model }
    },

    async complete(req) {
      const model = req.model ?? opts.model ?? loadedModel
      if (!model) throw new LlmError('No model selected: set LLM_MODEL or load a model in LM Studio')
      let res: OpenAI.Chat.Completions.ChatCompletion
      try {
        res = await openai.chat.completions.create({
          model,
          temperature: 0.2,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: { name: req.schemaName, strict: true, schema: req.schema },
          },
        })
      } catch (e) {
        throw new LlmError(`LLM request failed: ${(e as Error).message}`)
      }
      const content = res.choices[0]?.message?.content
      if (!content) throw new LlmError('LLM returned an empty response')
      return { content, model: res.model || model }
    },
  }
}

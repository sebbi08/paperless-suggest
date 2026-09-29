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

export function createLlmClient(opts: { baseUrl: string; model: string | null; timeoutMs?: number }): LlmClient {
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

  return {
    async health() {
      try {
        await openai.models.list()
      } catch (e) {
        return { ok: false, error: `LM Studio unreachable: ${(e as Error).message}` }
      }
      if (opts.model) return { ok: true, model: opts.model }
      loadedModel = await findLoadedModel().catch(() => null)
      if (!loadedModel) return { ok: false, error: 'No model loaded in LM Studio and LLM_MODEL is not set' }
      return { ok: true, model: loadedModel }
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

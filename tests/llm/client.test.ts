import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { createLlmClient, LlmError } from '../../src/llm/client'
import { useMswServer } from '../helpers/msw'

const ROOT = 'http://lmstudio.test:1234'
const BASE = `${ROOT}/v1`
const server = useMswServer()

const modelsList = http.get(`${BASE}/models`, () =>
  HttpResponse.json({ object: 'list', data: [{ id: 'qwen3-14b', object: 'model', owned_by: 'me', created: 0 }] }),
)
const v0Models = (data: unknown[]) => http.get(`${ROOT}/api/v0/models`, () => HttpResponse.json({ data }))
const completion = (content: string) => ({
  id: 'c1',
  object: 'chat.completion',
  created: 0,
  model: 'qwen3-14b',
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop', logprobs: null }],
})

describe('LlmClient.health', () => {
  it('reports the loaded LLM (ignoring embedding models)', async () => {
    server.use(
      modelsList,
      v0Models([
        { id: 'nomic-embed', type: 'embeddings', state: 'loaded' },
        { id: 'gemma-3-12b', type: 'llm', state: 'not-loaded' },
        { id: 'qwen3-14b', type: 'llm', state: 'loaded' },
      ]),
    )
    expect(await createLlmClient({ baseUrl: BASE, model: null }).health()).toEqual({ ok: true, model: 'qwen3-14b' })
  })

  it('prefers the configured model', async () => {
    server.use(modelsList)
    expect(await createLlmClient({ baseUrl: BASE, model: 'gemma-3-12b' }).health()).toEqual({ ok: true, model: 'gemma-3-12b' })
  })

  it('is not ok when no model is loaded and none configured', async () => {
    server.use(modelsList, v0Models([{ id: 'gemma-3-12b', type: 'llm', state: 'not-loaded' }]))
    const h = await createLlmClient({ baseUrl: BASE, model: null }).health()
    expect(h).toEqual({ ok: false, error: expect.stringMatching(/No model loaded/) })
  })

  it('is not ok when LM Studio is unreachable', async () => {
    server.use(http.get(`${BASE}/models`, () => HttpResponse.error()))
    const h = await createLlmClient({ baseUrl: BASE, model: 'x' }).health()
    expect(h).toEqual({ ok: false, error: expect.stringMatching(/unreachable/) })
  })
})

describe('LlmClient.complete', () => {
  it('sends a strict json_schema response_format and returns the content', async () => {
    let body: Record<string, unknown> = {}
    server.use(
      http.post(`${BASE}/chat/completions`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>
        return HttpResponse.json(completion('{"title":"x"}'))
      }),
    )
    const llm = createLlmClient({ baseUrl: BASE, model: 'qwen3-14b' })
    const res = await llm.complete({ system: 'sys', user: 'usr', schemaName: 'doc', schema: { type: 'object' } })
    expect(res).toEqual({ content: '{"title":"x"}', model: 'qwen3-14b' })
    expect(body).toMatchObject({
      model: 'qwen3-14b',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'usr' },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'doc', strict: true, schema: { type: 'object' } } },
    })
  })

  it('uses the per-request model override', async () => {
    let model = ''
    server.use(
      http.post(`${BASE}/chat/completions`, async ({ request }) => {
        model = ((await request.json()) as { model: string }).model
        return HttpResponse.json(completion('{}'))
      }),
    )
    await createLlmClient({ baseUrl: BASE, model: 'a' }).complete({ system: '', user: '', schemaName: 'd', schema: {}, model: 'b' })
    expect(model).toBe('b')
  })

  it('throws LlmError without any model', async () => {
    const llm = createLlmClient({ baseUrl: BASE, model: null })
    await expect(llm.complete({ system: '', user: '', schemaName: 'd', schema: {} })).rejects.toBeInstanceOf(LlmError)
  })

  it('wraps HTTP failures in LlmError', async () => {
    server.use(http.post(`${BASE}/chat/completions`, () => HttpResponse.json({ error: 'boom' }, { status: 500 })))
    const llm = createLlmClient({ baseUrl: BASE, model: 'm' })
    await expect(llm.complete({ system: '', user: '', schemaName: 'd', schema: {} })).rejects.toBeInstanceOf(LlmError)
  })
})

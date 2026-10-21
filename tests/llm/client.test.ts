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

describe('LlmClient model loading', () => {
  const instance = (contextLength: number, id = 'gemma-4-12b') => ({ id, config: { context_length: contextLength, parallel: 4 } })
  function lmStudio(instances: ReturnType<typeof instance>[], load: () => Response = () => HttpResponse.json({ status: 'loaded' })) {
    const calls: { path: string; body: unknown }[] = []
    server.use(
      modelsList,
      v0Models([{ id: 'gemma-4-12b', type: 'llm', state: instances.length ? 'loaded' : 'not-loaded' }]),
      http.get(`${ROOT}/api/v1/models`, () =>
        HttpResponse.json({
          models: [
            { type: 'llm', key: 'other-model', loaded_instances: [] },
            { type: 'llm', key: 'gemma-4-12b', loaded_instances: instances },
          ],
        }),
      ),
      http.post(`${ROOT}/api/v1/models/unload`, async ({ request }) => {
        calls.push({ path: 'unload', body: await request.json() })
        return HttpResponse.json({ instance_id: 'x' })
      }),
      http.post(`${ROOT}/api/v1/models/load`, async ({ request }) => {
        calls.push({ path: 'load', body: await request.json() })
        return load()
      }),
    )
    return calls
  }
  const client = (model: string | null = 'gemma-4-12b') => createLlmClient({ baseUrl: BASE, model, contextLength: 16384 })

  it('loads a model that is not loaded with the configured context length', async () => {
    const calls = lmStudio([])
    await client().ensureLoaded()
    expect(calls).toEqual([{ path: 'load', body: { model: 'gemma-4-12b', context_length: 16384 } }])
  })

  it('reloads a model loaded with a smaller context', async () => {
    const calls = lmStudio([instance(8192), instance(4096, 'gemma-4-12b:2')])
    await client().ensureLoaded()
    expect(calls).toEqual([
      { path: 'unload', body: { instance_id: 'gemma-4-12b' } },
      { path: 'unload', body: { instance_id: 'gemma-4-12b:2' } },
      { path: 'load', body: { model: 'gemma-4-12b', context_length: 16384 } },
    ])
  })

  it('leaves a model alone that already has at least that context', async () => {
    const calls = lmStudio([instance(32768)])
    await client().ensureLoaded()
    expect(calls).toEqual([])
  })

  it('uses the loaded model when LLM_MODEL is not set', async () => {
    const calls = lmStudio([instance(8192)])
    const llm = client(null)
    expect(await llm.health()).toEqual({ ok: true, model: 'gemma-4-12b' })
    await llm.ensureLoaded()
    expect(calls.map((c) => c.path)).toEqual(['unload', 'load'])
  })

  it('throws when the load fails', async () => {
    lmStudio([], () => HttpResponse.json({ error: 'Not enough VRAM' }, { status: 500 }))
    await expect(client().ensureLoaded()).rejects.toThrow(/Could not load gemma-4-12b with context length 16384:.*Not enough VRAM/)
  })

  it('does not load anything on a health check', async () => {
    const calls = lmStudio([])
    expect(await client().health()).toEqual({ ok: true, model: 'gemma-4-12b' })
    expect(calls).toEqual([])
  })

  it('leaves loading to LM Studio without a context length', async () => {
    const calls = lmStudio([])
    await createLlmClient({ baseUrl: BASE, model: 'gemma-4-12b' }).ensureLoaded()
    expect(calls).toEqual([])
  })

  it('unloads every loaded instance of the model', async () => {
    const calls = lmStudio([instance(16384), instance(16384, 'gemma-4-12b:2')])
    await client().unload()
    expect(calls).toEqual([
      { path: 'unload', body: { instance_id: 'gemma-4-12b' } },
      { path: 'unload', body: { instance_id: 'gemma-4-12b:2' } },
    ])
  })

  it('unloads nothing when the model is not loaded', async () => {
    const calls = lmStudio([])
    await client().unload()
    expect(calls).toEqual([])
  })

  it('still knows the model after unloading it when LLM_MODEL is not set', async () => {
    lmStudio([instance(16384)])
    const llm = client(null)
    await llm.health()
    lmStudio([])
    expect(await llm.health()).toEqual({ ok: true, model: 'gemma-4-12b' })
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

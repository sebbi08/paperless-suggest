import { describe, expect, it, vi } from 'vitest'
import { LlmError, type LlmClient, type LlmHealth, type LlmModelControl } from '../../src/llm/client'
import { PaperlessError } from '../../src/paperless/client'
import type { PaperlessDocument } from '../../src/paperless/types'
import { openDb } from '../../src/store/db'
import { SuggestionStore } from '../../src/store/suggestions'
import type { SuggestInput, SuggestResult } from '../../src/suggest/types'
import { BACKOFF_MAX_MS, Worker } from '../../src/worker/worker'
import { fakePaperless, silentLogger } from '../helpers/fakes'
import { makeDocument, makeVocabulary } from '../helpers/fixtures'

const okResult: SuggestResult = {
  kind: 'ok',
  suggestion: { title: 'T', createdDate: null, correspondentId: 10, proposedCorrespondent: null, tagIds: [2], proposedTags: [], matchedNotes: {}, model: 'm' },
}
const online: LlmHealth = { ok: true, model: 'm' }
const offline: LlmHealth = { ok: false, error: 'LM Studio unreachable: connect ECONNREFUSED' }

function setup(healthSequence: LlmHealth[] = [online], opts: { llmConcurrency?: number; docCount?: number; unloadWhenIdle?: boolean } = {}) {
  const store = new SuggestionStore(openDb(':memory:'))
  const v = makeVocabulary()
  const words = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth']
  let docs: PaperlessDocument[] = words
    .slice(0, opts.docCount ?? 2)
    .map((content, i) => makeDocument({ id: i + 1, added: `2026-09-0${i + 1}`, content }))
  const paperless = fakePaperless({
    listTags: vi.fn(async () => v.tags),
    listCorrespondents: vi.fn(async () => v.correspondents),
    listInboxDocuments: vi.fn(async () => docs),
    listFiledDocuments: vi.fn(async () => [
      makeDocument({ id: 1, title: 'Self', tags: [2] }),
      makeDocument({ id: 50, title: 'Filed 50', tags: [2] }),
    ]),
  })
  const health = [...healthSequence]
  const llm = {
    complete: vi.fn(),
    health: vi.fn(async () => (health.length > 1 ? health.shift()! : health[0]!)),
    ensureLoaded: vi.fn(async () => {}),
    unload: vi.fn(async () => {}),
  } satisfies LlmClient & LlmModelControl
  const suggester = { suggest: vi.fn(async (_input: SuggestInput): Promise<SuggestResult> => okResult) }
  const worker = new Worker({
    paperless,
    llm,
    suggester,
    store,
    inboxTag: null,
    pollIntervalSec: 300,
    llmConcurrency: opts.llmConcurrency,
    unloadWhenIdle: opts.unloadWhenIdle,
    logger: silentLogger,
  })
  return { store, paperless, llm, suggester, worker, setDocs: (d: PaperlessDocument[]) => (docs = d) }
}

describe('Worker', () => {
  it('syncs the inbox but waits while the LLM is offline, with growing backoff', async () => {
    const { store, suggester, worker } = setup([offline])
    await worker.tick()
    expect(store.counts().pending).toBe(2)
    expect(suggester.suggest).not.toHaveBeenCalled()
    expect(worker.status().llm).toEqual({ ok: false, model: null, error: offline.error })
    expect(worker.nextDelayMs()).toBe(60_000)
    await worker.tick()
    expect(worker.nextDelayMs()).toBe(120_000)
    for (let i = 0; i < 6; i++) await worker.tick()
    expect(worker.nextDelayMs()).toBe(BACKOFF_MAX_MS)
  })

  it('processes pending documents oldest first when the LLM is online', async () => {
    const { store, suggester, worker } = setup()
    await worker.tick()
    expect(suggester.suggest.mock.calls.map((c) => c[0].content)).toEqual(['first', 'second'])
    expect(store.get(1)?.status).toBe('ready')
    expect(store.get(2)?.status).toBe('ready')
    expect(worker.status()).toMatchObject({ paperless: { ok: true }, llm: { ok: true, model: 'm' } })
    expect(worker.status().lastPollAt).not.toBeNull()
    expect(worker.nextDelayMs()).toBe(300_000)
  })

  it('never uses the document itself as a few-shot example', async () => {
    const { suggester, worker } = setup()
    await worker.tick()
    expect(suggester.suggest.mock.calls[0]![0].examples.map((e) => e.title)).toEqual(['Filed 50'])
  })

  it('resumes after the LLM comes back and resets the backoff', async () => {
    const { store, worker } = setup([offline, online])
    await worker.tick()
    await worker.tick()
    expect(store.counts()).toMatchObject({ ready: 2, pending: 0 })
    expect(worker.nextDelayMs()).toBe(300_000)
  })

  it('stops processing and keeps documents pending when the LLM drops mid-run', async () => {
    const { store, suggester, worker } = setup([online, offline])
    suggester.suggest.mockResolvedValueOnce(okResult).mockRejectedValueOnce(new LlmError('socket hang up'))
    await worker.tick()
    expect(store.get(1)?.status).toBe('ready')
    expect(store.get(2)?.status).toBe('pending')
    expect(worker.status().llm).toEqual({ ok: false, model: null, error: offline.error })
    expect(worker.nextDelayMs()).toBe(60_000)
  })

  it('marks a document the LLM rejects as error and continues while the LLM is healthy', async () => {
    const { store, suggester, worker } = setup()
    suggester.suggest.mockRejectedValueOnce(new LlmError('context length exceeded')).mockResolvedValueOnce(okResult)
    await worker.tick()
    expect(store.get(1)).toMatchObject({ status: 'error', error: 'context length exceeded' })
    expect(store.get(2)?.status).toBe('ready')
    expect(worker.status().llm.ok).toBe(true)
  })

  it('marks blank documents no_text without needing the LLM', async () => {
    const { store, suggester, worker, setDocs } = setup([offline])
    setDocs([makeDocument({ id: 1, added: '2026-09-01', content: '  \n ' }), makeDocument({ id: 2, added: '2026-09-02', content: 'x' })])
    await worker.tick()
    expect(store.get(1)?.status).toBe('no_text')
    expect(store.get(2)?.status).toBe('pending')
    expect(store.nextReviewable()).toBe(1)
    expect(suggester.suggest).not.toHaveBeenCalled()
  })

  it('reports Paperless failures without throwing', async () => {
    const { paperless, llm, worker } = setup()
    vi.mocked(paperless.listTags).mockRejectedValueOnce(new PaperlessError('Paperless GET /api/tags/ failed: 502', 502))
    await expect(worker.tick()).resolves.toBeUndefined()
    expect(worker.status().paperless).toEqual({ ok: false, error: expect.stringContaining('502') })
    expect(llm.health).not.toHaveBeenCalled()
  })

  it('reports a missing inbox tag as a Paperless problem', async () => {
    const { paperless, worker } = setup()
    vi.mocked(paperless.listTags).mockResolvedValueOnce(makeVocabulary().tags.filter((t) => !t.isInboxTag))
    await worker.tick()
    expect(worker.status().paperless.error).toMatch(/INBOX_TAG/)
  })

  it('drops documents that left the inbox', async () => {
    const { store, worker, setDocs } = setup()
    await worker.tick()
    setDocs([makeDocument({ id: 2, added: '2026-09-02', content: 'second' })])
    await worker.tick()
    expect(store.nextReviewable()).toBe(2)
    expect(store.nextReviewable(2)).toBeNull()
  })

  describe('with LLM_CONCURRENCY > 1', () => {
    /** Suggestions that finish only when the test releases them. */
    function gate(suggester: ReturnType<typeof setup>['suggester']) {
      const waiting: { content: string; release: (r: Promise<SuggestResult>) => void }[] = []
      let active = 0
      let maxActive = 0
      suggester.suggest.mockImplementation(async (input) => {
        active++
        maxActive = Math.max(maxActive, active)
        try {
          return await new Promise<Promise<SuggestResult>>((release) => waiting.push({ content: input.content, release }))
        } finally {
          active--
        }
      })
      const started = () => waiting.map((w) => w.content)
      const settle = async () => {
        await vi.waitFor(() => expect(waiting.length).toBeGreaterThan(0))
        return waiting.shift()!
      }
      return { started, settle, maxActive: () => maxActive }
    }

    it('suggests for up to that many documents at the same time, each exactly once', async () => {
      const { store, suggester, worker } = setup([online], { llmConcurrency: 3, docCount: 5 })
      const g = gate(suggester)
      const run = worker.tick()
      await vi.waitFor(() => expect(g.started()).toEqual(['first', 'second', 'third']))
      for (let i = 0; i < 5; i++) (await g.settle()).release(Promise.resolve(okResult))
      await run
      expect(g.maxActive()).toBe(3)
      expect(suggester.suggest.mock.calls.map((c) => c[0].content).sort()).toEqual(['fifth', 'first', 'fourth', 'second', 'third'])
      expect(store.counts()).toMatchObject({ ready: 5, pending: 0 })
    })

    it('stops every lane once when the LLM goes down, keeping the rest pending', async () => {
      const { store, suggester, worker } = setup([online, offline], { llmConcurrency: 2, docCount: 4 })
      const g = gate(suggester)
      const run = worker.tick()
      await vi.waitFor(() => expect(g.started()).toEqual(['first', 'second']))
      ;(await g.settle()).release(Promise.reject(new LlmError('socket hang up')))
      ;(await g.settle()).release(Promise.reject(new LlmError('socket hang up')))
      await run
      expect(suggester.suggest).toHaveBeenCalledTimes(2)
      expect(store.counts()).toMatchObject({ ready: 0, pending: 4, error: 0 })
      expect(worker.status().llm.ok).toBe(false)
      expect(worker.nextDelayMs()).toBe(60_000)
    })

    it('finishes suggestions already running when another lane fails', async () => {
      const { store, suggester, worker } = setup([online, offline], { llmConcurrency: 2, docCount: 3 })
      const g = gate(suggester)
      const run = worker.tick()
      await vi.waitFor(() => expect(g.started()).toEqual(['first', 'second']))
      const [first, second] = [await g.settle(), await g.settle()]
      first.release(Promise.reject(new LlmError('socket hang up')))
      second.release(Promise.resolve(okResult))
      await run
      expect(store.get(2)?.status).toBe('ready')
      expect(store.get(3)?.status).toBe('pending')
      expect(suggester.suggest).toHaveBeenCalledTimes(2)
    })
  })

  it('runs in the background and reacts to wake()', async () => {
    const { store, suggester, worker } = setup()
    worker.start()
    try {
      await vi.waitFor(() => expect(suggester.suggest).toHaveBeenCalledTimes(2))
      store.requestRegenerate(1)
      worker.wake()
      await vi.waitFor(() => expect(suggester.suggest).toHaveBeenCalledTimes(3))
      expect(store.get(1)?.status).toBe('ready')
    } finally {
      worker.stop()
    }
  })

  describe('model loading', () => {
    it('loads the model before working through the queue', async () => {
      const { llm, suggester, worker } = setup()
      await worker.tick()
      expect(llm.ensureLoaded).toHaveBeenCalledOnce()
      expect(llm.ensureLoaded.mock.invocationCallOrder[0]).toBeLessThan(suggester.suggest.mock.invocationCallOrder[0]!)
    })

    it('does not load the model when there is nothing to do', async () => {
      const { llm, worker } = setup([online], { docCount: 0 })
      await worker.tick()
      expect(llm.ensureLoaded).not.toHaveBeenCalled()
      expect(worker.status().llm).toEqual({ ok: true, model: 'm', error: null })
    })

    it('reports the LLM offline and suggests nothing when loading fails', async () => {
      const { llm, store, suggester, worker } = setup()
      llm.ensureLoaded.mockRejectedValueOnce(new Error('Could not load m with context length 16384: Not enough VRAM'))
      await worker.tick()
      expect(suggester.suggest).not.toHaveBeenCalled()
      expect(store.counts().pending).toBe(2)
      expect(worker.status().llm).toEqual({ ok: false, model: null, error: 'Could not load m with context length 16384: Not enough VRAM' })
    })

    it('unloads the model once the queue is empty', async () => {
      const { llm, store, worker } = setup([online], { unloadWhenIdle: true })
      await worker.tick()
      expect(store.counts().ready).toBe(2)
      expect(llm.unload).toHaveBeenCalledOnce()
      await worker.tick()
      expect(llm.unload).toHaveBeenCalledOnce()
    })

    it('keeps the model loaded without unloadWhenIdle', async () => {
      const { llm, worker } = setup()
      await worker.tick()
      expect(llm.unload).not.toHaveBeenCalled()
    })

    it('does not unload a model it did not use', async () => {
      const { llm, worker } = setup([online], { unloadWhenIdle: true, docCount: 0 })
      await worker.tick()
      expect(llm.unload).not.toHaveBeenCalled()
    })

    it('keeps the model loaded while documents are left', async () => {
      const { llm, suggester, store, worker } = setup([online, offline], { unloadWhenIdle: true })
      suggester.suggest.mockRejectedValueOnce(new LlmError('socket hang up'))
      await worker.tick()
      expect(store.counts().pending).toBe(2)
      expect(llm.unload).not.toHaveBeenCalled()
    })

    it('unloads once the remaining documents leave the inbox', async () => {
      const { llm, suggester, worker, setDocs } = setup([online, offline, online], { unloadWhenIdle: true })
      suggester.suggest.mockRejectedValueOnce(new LlmError('socket hang up'))
      await worker.tick()
      setDocs([])
      await worker.tick()
      expect(llm.unload).toHaveBeenCalledOnce()
    })

    it('keeps working when the unload fails', async () => {
      const { llm, store, worker, setDocs } = setup([online], { unloadWhenIdle: true })
      llm.unload.mockRejectedValueOnce(new Error('POST /api/v1/models/unload failed: 404'))
      await worker.tick()
      setDocs([makeDocument({ id: 7, added: '2026-09-07', content: 'seventh' })])
      await worker.tick()
      expect(store.get(7)?.status).toBe('ready')
    })
  })
})

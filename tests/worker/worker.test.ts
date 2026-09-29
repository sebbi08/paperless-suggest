import { describe, expect, it, vi } from 'vitest'
import { LlmError, type LlmClient, type LlmHealth } from '../../src/llm/client'
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
  suggestion: { title: 'T', correspondentId: 10, proposedCorrespondent: null, tagIds: [2], proposedTags: [], matchedNotes: {}, model: 'm' },
}
const online: LlmHealth = { ok: true, model: 'm' }
const offline: LlmHealth = { ok: false, error: 'LM Studio unreachable: connect ECONNREFUSED' }

function setup(healthSequence: LlmHealth[] = [online]) {
  const store = new SuggestionStore(openDb(':memory:'))
  const v = makeVocabulary()
  let docs: PaperlessDocument[] = [
    makeDocument({ id: 1, added: '2026-09-01', content: 'first' }),
    makeDocument({ id: 2, added: '2026-09-02', content: 'second' }),
  ]
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
  const llm: LlmClient = {
    complete: vi.fn(),
    health: vi.fn(async () => (health.length > 1 ? health.shift()! : health[0]!)),
  }
  const suggester = { suggest: vi.fn(async (_input: SuggestInput): Promise<SuggestResult> => okResult) }
  const worker = new Worker({ paperless, llm, suggester, store, inboxTag: null, pollIntervalSec: 300, logger: silentLogger })
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
})

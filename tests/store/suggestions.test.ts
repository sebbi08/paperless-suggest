import { beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../../src/store/db'
import { SuggestionStore } from '../../src/store/suggestions'
import type { SuggestResult } from '../../src/suggest/types'

const ok: SuggestResult = {
  kind: 'ok',
  suggestion: {
    title: 'Telekom Rechnung',
    createdDate: '2026-09-14',
    correspondentId: 10,
    proposedCorrespondent: null,
    tagIds: [2],
    proposedTags: [{ name: 'Mobilfunk', nearest: [{ id: 3, name: 'Telefon/Internet', score: 0.3 }] }],
    matchedNotes: { Telekom: 'Deutsche Telekom AG' },
    model: 'qwen3-14b',
  },
}
const meta = (contentHash = 'c1', vocabHash = 'v1') => ({ contentHash, vocabHash, docModified: 'm1' })
const item = (documentId: number, added: string, contentHash = 'c1') => ({ documentId, added, contentHash })

let store: SuggestionStore
let clock: number

beforeEach(() => {
  clock = Date.parse('2026-09-29T10:00:00Z')
  store = new SuggestionStore(openDb(':memory:'), () => new Date(clock))
})

describe('SuggestionStore', () => {
  it('adds new inbox documents as pending and hands out work oldest first', () => {
    store.syncInbox([item(2, '2026-09-02'), item(1, '2026-09-01')], 'v1')
    expect(store.get(1)?.status).toBe('pending')
    expect(store.nextWork()).toBe(1)
    expect(store.counts()).toEqual({ ready: 0, pending: 2, error: 0, noText: 0 })
  })

  it('skips documents that are already being worked on', () => {
    store.syncInbox([item(1, '2026-09-01'), item(2, '2026-09-02'), item(3, '2026-09-03')], 'v1')
    expect(store.nextWork(new Set([1]))).toBe(2)
    expect(store.nextWork(new Set([1, 2, 3]))).toBeNull()
  })

  it('stores and returns a suggestion', () => {
    store.syncInbox([item(1, '2026-09-01')], 'v1')
    store.saveResult(1, ok, meta())
    expect(store.get(1)).toEqual({
      documentId: 1,
      status: 'ready',
      title: 'Telekom Rechnung',
      createdDate: '2026-09-14',
      correspondentId: 10,
      proposedCorrespondent: null,
      tagIds: [2],
      proposedTags: [{ name: 'Mobilfunk', nearest: [{ id: 3, name: 'Telefon/Internet', score: 0.3 }] }],
      matchedNotes: { Telekom: 'Deutsche Telekom AG' },
      model: 'qwen3-14b',
      error: null,
      docModified: 'm1',
      updatedAt: '2026-09-29T10:00:00.000Z',
    })
    expect(store.nextWork()).toBeNull()
  })

  it('stores errors and no_text results', () => {
    store.syncInbox([item(1, 'a'), item(2, 'b')], 'v1')
    store.saveResult(1, { kind: 'error', error: 'bad output', model: 'm' }, meta())
    store.saveResult(2, { kind: 'no_text' }, meta())
    expect(store.get(1)).toMatchObject({ status: 'error', error: 'bad output', model: 'm', title: null })
    expect(store.get(2)).toMatchObject({ status: 'no_text', error: null })
    expect(store.counts()).toEqual({ ready: 0, pending: 0, error: 1, noText: 1 })
  })

  it('keeps stale ready/error rows reviewable but queues them for refresh', () => {
    store.syncInbox([item(1, 'a'), item(2, 'b'), item(3, 'c')], 'v1')
    store.saveResult(1, ok, meta('c1', 'v1'))
    store.saveResult(2, ok, meta('c1', 'v1'))
    store.saveResult(3, { kind: 'error', error: 'x', model: null }, meta('c1', 'v1'))
    clock += 60_000
    store.syncInbox([item(1, 'a', 'c2'), item(2, 'b'), item(3, 'c')], 'v1')
    expect(store.get(1)?.status).toBe('ready')
    expect(store.get(1)?.updatedAt).toBe('2026-09-29T10:00:00.000Z')
    expect(store.nextReviewable()).toBe(1)
    expect(store.nextWork()).toBe(1)
    store.saveResult(1, ok, meta('c2', 'v1'))
    expect(store.nextWork()).toBeNull()
    store.syncInbox([item(1, 'a', 'c2'), item(2, 'b'), item(3, 'c')], 'v2')
    expect(store.get(2)?.status).toBe('ready')
    expect(store.get(3)?.status).toBe('error')
    expect(store.nextReviewable(1)).toBe(2)
    expect(store.nextWork()).toBe(1)
    store.saveResult(1, ok, meta('c2', 'v2'))
    store.saveResult(2, ok, meta('c1', 'v2'))
    expect(store.nextWork()).toBe(3)
    store.saveResult(3, ok, meta('c1', 'v2'))
    expect(store.nextWork()).toBeNull()
  })

  it('resets a no_text row to pending when its content changes', () => {
    store.syncInbox([item(1, 'a')], 'v1')
    store.saveResult(1, { kind: 'no_text' }, meta('c1', 'v1'))
    store.syncInbox([item(1, 'a', 'c2')], 'v1')
    expect(store.get(1)?.status).toBe('pending')
  })

  it('does not overwrite an applied document with a late result', () => {
    store.syncInbox([item(1, 'a')], 'v1')
    store.markApplied(1)
    store.saveResult(1, ok, meta())
    expect(store.get(1)?.status).toBe('applied')
  })

  it('never re-queues or revives an applied document that was stale', () => {
    store.syncInbox([item(1, 'a')], 'v1')
    store.saveResult(1, ok, meta('c1', 'v1'))
    store.syncInbox([item(1, 'a')], 'v2')
    expect(store.isStale(1)).toBe(true)
    store.markApplied(1)
    expect(store.nextWork()).toBeNull()
    expect(store.isStale(1)).toBe(false)
    store.saveResult(1, ok, meta('c1', 'v2'))
    expect(store.get(1)?.status).toBe('applied')
    expect(store.nextReviewable()).toBeNull()
  })

  it('does not touch updatedAt when a poll changes nothing', () => {
    store.syncInbox([item(1, 'a')], 'v1')
    store.saveResult(1, ok, meta())
    clock += 60_000
    store.syncInbox([item(1, 'a')], 'v1')
    expect(store.get(1)?.updatedAt).toBe('2026-09-29T10:00:00.000Z')
  })

  it('drops documents that left the inbox from queue and counts', () => {
    store.syncInbox([item(1, 'a'), item(2, 'b')], 'v1')
    store.saveResult(1, ok, meta())
    store.syncInbox([item(2, 'b')], 'v1')
    expect(store.nextReviewable()).toBeNull()
    expect(store.counts().ready).toBe(0)
    expect(store.get(1)?.status).toBe('ready')
  })

  it('resets an applied document that is back in the inbox', () => {
    store.syncInbox([item(1, 'a')], 'v1')
    store.saveResult(1, ok, meta())
    store.markApplied(1)
    store.syncInbox([], 'v1')
    store.syncInbox([item(1, 'a')], 'v1')
    expect(store.get(1)?.status).toBe('pending')
  })

  it('walks reviewable documents in inbox order', () => {
    store.syncInbox([item(3, '2026-09-03'), item(1, '2026-09-01'), item(2, '2026-09-01')], 'v1')
    store.saveResult(1, ok, meta())
    store.saveResult(2, { kind: 'error', error: 'x', model: null }, meta())
    store.saveResult(3, { kind: 'no_text' }, meta())
    expect(store.nextReviewable()).toBe(1)
    expect(store.nextReviewable(1)).toBe(2)
    expect(store.nextReviewable(2)).toBe(3)
    expect(store.nextReviewable(3)).toBeNull()
    store.markApplied(1)
    expect(store.nextReviewable()).toBe(2)
    expect(store.nextReviewable(1)).toBe(2)
    expect(store.nextReviewable(999)).toBe(2)
  })

  it('prioritises regeneration requests', () => {
    store.syncInbox([item(1, 'a'), item(2, 'b')], 'v1')
    store.saveResult(2, ok, meta())
    expect(store.requestRegenerate(2)).toBe(true)
    expect(store.get(2)?.status).toBe('pending')
    expect(store.nextWork()).toBe(2)
    store.saveResult(2, ok, meta())
    expect(store.nextWork()).toBe(1)
  })

  it('refuses to regenerate unknown or applied documents', () => {
    store.syncInbox([item(1, 'a')], 'v1')
    store.markApplied(1)
    expect(store.requestRegenerate(1)).toBe(false)
    expect(store.requestRegenerate(42)).toBe(false)
  })

  it('stores meta values', () => {
    expect(store.getMeta('k')).toBeNull()
    store.setMeta('k', 'v')
    store.setMeta('k', 'w')
    expect(store.getMeta('k')).toBe('w')
  })
})

import { describe, expect, it, vi } from 'vitest'
import { LlmError, type LlmClient, type LlmRequest } from '../../src/llm/client'
import { createSuggester } from '../../src/suggest/suggester'
import type { Vocabulary } from '../../src/paperless/types'
import { makeVocabulary } from '../helpers/fixtures'

function fakeLlm(...contents: string[]) {
  const requests: LlmRequest[] = []
  const llm: LlmClient = {
    health: vi.fn(),
    complete: vi.fn(async (req: LlmRequest) => {
      requests.push(req)
      const content = contents.shift()
      if (content === undefined) throw new Error('no more fake responses')
      return { content, model: req.model ?? 'fake-model' }
    }),
  }
  return { llm, requests }
}

const out = (o: Record<string, unknown>) =>
  JSON.stringify({ title: 'Telekom Rechnung', correspondent: null, proposed_new_correspondent: null, tags: [], proposed_new_tags: [], ...o })

const input = (content = 'Deutsche Telekom AG Rechnung', vocabulary: Vocabulary = makeVocabulary()) => ({
  content,
  vocabulary,
  examples: [],
})

const make = (llm: LlmClient) => createSuggester({ llm, maxContentChars: 6000, matchThreshold: 0.85 })

describe('Suggester', () => {
  it('returns no_text without calling the LLM for empty content', async () => {
    const { llm } = fakeLlm()
    expect(await make(llm).suggest(input('   \n '))).toEqual({ kind: 'no_text' })
    expect(llm.complete).not.toHaveBeenCalled()
  })

  it('resolves names to ids', async () => {
    const { llm, requests } = fakeLlm(out({ correspondent: 'Deutsche Telekom AG', tags: ['Rechnung', 'Telefon/Internet'] }))
    const r = await make(llm).suggest(input())
    expect(r).toEqual({
      kind: 'ok',
      suggestion: {
        title: 'Telekom Rechnung',
        correspondentId: 10,
        proposedCorrespondent: null,
        tagIds: [2, 3],
        proposedTags: [],
        matchedNotes: {},
        model: 'fake-model',
      },
    })
    expect(requests[0]!.schemaName).toBe('document_suggestion')
    expect(requests[0]!.user).toContain('Deutsche Telekom AG Rechnung')
  })

  it('retries once on invalid output', async () => {
    const { llm } = fakeLlm('garbage', out({ tags: ['Rechnung'] }))
    const r = await make(llm).suggest(input())
    expect(r.kind).toBe('ok')
    expect(llm.complete).toHaveBeenCalledTimes(2)
  })

  it('returns an error after two invalid outputs', async () => {
    const { llm } = fakeLlm(out({ tags: ['Nope'] }), out({ tags: ['Nope'] }))
    const r = await make(llm).suggest(input())
    expect(r).toEqual({ kind: 'error', error: expect.stringContaining('unknown tag'), model: 'fake-model' })
  })

  it('propagates LLM transport errors', async () => {
    const llm: LlmClient = { health: vi.fn(), complete: vi.fn(async () => { throw new LlmError('down') }) }
    await expect(make(llm).suggest(input())).rejects.toBeInstanceOf(LlmError)
  })

  it('auto-maps a proposed correspondent that matches an existing one', async () => {
    const { llm } = fakeLlm(out({ proposed_new_correspondent: 'Telekom' }))
    const r = await make(llm).suggest(input())
    expect(r.kind === 'ok' && r.suggestion).toMatchObject({
      correspondentId: 10,
      proposedCorrespondent: null,
      matchedNotes: { Telekom: 'Deutsche Telekom AG' },
    })
  })

  it('keeps a genuinely new tag as proposal with nearest names', async () => {
    const { llm } = fakeLlm(out({ tags: ['Rechnung'], proposed_new_tags: ['Mobilfunk'] }))
    const r = await make(llm).suggest(input())
    expect(r.kind === 'ok' && r.suggestion.proposedTags).toEqual([
      { name: 'Mobilfunk', nearest: expect.any(Array) },
    ])
  })

  it('maps a near-duplicate tag without duplicating it', async () => {
    const { llm } = fakeLlm(out({ tags: ['Rechnung'], proposed_new_tags: ['Rechnungen'] }))
    const r = await make(llm).suggest(input())
    expect(r.kind === 'ok' && r.suggestion).toMatchObject({ tagIds: [2], proposedTags: [], matchedNotes: {} })
  })

  it('works with an empty vocabulary, turning everything into proposals', async () => {
    const empty: Vocabulary = { inboxTagId: 1, tags: [{ id: 1, name: 'Inbox', isInboxTag: true, documentCount: 0 }], correspondents: [] }
    const { llm } = fakeLlm(out({ proposed_new_correspondent: 'Telekom', proposed_new_tags: ['Rechnung'] }))
    const r = await make(llm).suggest(input('Telekom Rechnung', empty))
    expect(r.kind === 'ok' && r.suggestion).toMatchObject({
      correspondentId: null,
      proposedCorrespondent: { name: 'Telekom', nearest: [] },
      tagIds: [],
      proposedTags: [{ name: 'Rechnung', nearest: [] }],
    })
  })

  it('passes the model override and truncates content', async () => {
    const { llm, requests } = fakeLlm(out({}))
    const s = createSuggester({ llm, maxContentChars: 10, matchThreshold: 0.85 })
    await s.suggest({ ...input('0123456789ABCDEF'), model: 'gemma' })
    expect(requests[0]!.model).toBe('gemma')
    expect(requests[0]!.user).toContain('0123456789\n[…]')
    expect(requests[0]!.user).not.toContain('ABCDEF')
  })
})

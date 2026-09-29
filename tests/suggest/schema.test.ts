import { describe, expect, it } from 'vitest'
import { buildSuggestionSchema, extractJson, parseSuggestionOutput, TITLE_MAX } from '../../src/suggest/schema'
import type { Vocabulary } from '../../src/paperless/types'
import { makeVocabulary } from '../helpers/fixtures'

type Json = Record<string, any>

const emptyVocab = (): Vocabulary => ({
  inboxTagId: 1,
  tags: [{ id: 1, name: 'Inbox', isInboxTag: true, documentCount: 0 }],
  correspondents: [],
})

const output = (o: Json) => JSON.stringify({ proposed_new_correspondent: null, proposed_new_tags: [], ...o })

describe('buildSuggestionSchema', () => {
  it('restricts tags to existing names without the inbox tag', () => {
    const s = buildSuggestionSchema(makeVocabulary()) as Json
    expect(s.properties.tags.items.enum).toEqual(['Rechnung', 'Telefon/Internet', 'Versicherung', 'Müller "Bau"'])
    expect(s.properties.proposed_new_tags.maxItems).toBe(2)
    expect(s.properties.title.maxLength).toBe(TITLE_MAX)
    expect(s.required).toEqual(['title', 'correspondent', 'proposed_new_correspondent', 'tags', 'proposed_new_tags'])
  })

  it('allows an existing correspondent or null', () => {
    const s = buildSuggestionSchema(makeVocabulary()) as Json
    expect(s.properties.correspondent).toEqual({
      anyOf: [
        { type: 'string', enum: ['Deutsche Telekom AG', 'Stadtwerke München GmbH', 'Allianz Versicherung'] },
        { type: 'null' },
      ],
    })
  })

  it('produces a valid schema for an empty vocabulary', () => {
    const s = buildSuggestionSchema(emptyVocab()) as Json
    expect(s.properties.correspondent).toEqual({ type: 'null' })
    expect(s.properties.tags).toEqual({ type: 'array', items: { type: 'string' }, maxItems: 0 })
  })
})

describe('extractJson', () => {
  it('strips reasoning blocks and code fences', () => {
    expect(extractJson('<think>hmm {not json}</think>\n```json\n{"a":1}\n```')).toBe('{"a":1}')
  })

  it('cuts surrounding prose', () => {
    expect(extractJson('Here you go: {"a":1} hope it helps')).toBe('{"a":1}')
  })
})

describe('parseSuggestionOutput', () => {
  const v = makeVocabulary()

  it('accepts valid output', () => {
    const r = parseSuggestionOutput(output({ title: 'Telekom Rechnung', correspondent: 'Deutsche Telekom AG', tags: ['Rechnung'] }), v)
    expect(r).toEqual({
      ok: true,
      value: { title: 'Telekom Rechnung', correspondent: 'Deutsche Telekom AG', proposed_new_correspondent: null, tags: ['Rechnung'], proposed_new_tags: [] },
    })
  })

  it('round-trips names with special characters', () => {
    const r = parseSuggestionOutput(output({ title: 'x', correspondent: null, tags: ['Telefon/Internet', 'Müller "Bau"'] }), v)
    expect(r.ok && r.value.tags).toEqual(['Telefon/Internet', 'Müller "Bau"'])
  })

  it('parses output wrapped in a reasoning block', () => {
    const r = parseSuggestionOutput(`<think>Let me see.</think>${output({ title: 'x', correspondent: null, tags: [] })}`, v)
    expect(r.ok).toBe(true)
  })

  it('defaults missing proposal fields', () => {
    const r = parseSuggestionOutput(JSON.stringify({ title: 'x', correspondent: null, tags: [] }), v)
    expect(r.ok && r.value).toMatchObject({ proposed_new_correspondent: null, proposed_new_tags: [] })
  })

  it('truncates long titles and dedupes tags', () => {
    const r = parseSuggestionOutput(output({ title: 'A'.repeat(100), correspondent: null, tags: ['Rechnung', 'Rechnung'] }), v)
    expect(r.ok && r.value.title).toHaveLength(TITLE_MAX)
    expect(r.ok && r.value.tags).toEqual(['Rechnung'])
  })

  it('rejects unknown tags and correspondents', () => {
    const tag = parseSuggestionOutput(output({ title: 'x', correspondent: null, tags: ['Nope'] }), v)
    expect(tag).toEqual({ ok: false, error: expect.stringContaining('tags.0') })
    const corr = parseSuggestionOutput(output({ title: 'x', correspondent: 'Nope', tags: [] }), v)
    expect(corr).toEqual({ ok: false, error: expect.stringContaining('correspondent') })
  })

  it('rejects the inbox tag', () => {
    expect(parseSuggestionOutput(output({ title: 'x', correspondent: null, tags: ['Inbox'] }), v).ok).toBe(false)
  })

  it('rejects invalid JSON and empty titles', () => {
    expect(parseSuggestionOutput('not json', v)).toEqual({ ok: false, error: expect.stringMatching(/not valid JSON/) })
    expect(parseSuggestionOutput(output({ title: '  ', correspondent: null, tags: [] }), v).ok).toBe(false)
  })

  it('accepts output for an empty vocabulary', () => {
    const r = parseSuggestionOutput(output({ title: 'x', correspondent: null, tags: [], proposed_new_tags: ['Neu'] }), emptyVocab())
    expect(r.ok && r.value.proposed_new_tags).toEqual(['Neu'])
  })
})

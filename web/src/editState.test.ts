import { describe, expect, it } from 'vitest'
import {
  addExistingTag,
  addNewTag,
  applyMissing,
  canApply,
  initialEditState,
  removeTagAt,
  replaceNewTag,
  toApplyRequest,
  type TagEntry,
} from './editState'
import { makeDetail } from './test/fixtures'

const options = makeDetail().vocabulary.tags

describe('initialEditState', () => {
  it('takes a ready suggestion', () => {
    expect(initialEditState(makeDetail())).toEqual({
      title: 'Telekom Rechnung 1',
      correspondent: { kind: 'existing', id: 10 },
      tags: [
        { kind: 'existing', id: 2 },
        { kind: 'new', name: 'Mobilfunk', nearest: [{ id: 3, name: 'Telefon/Internet', score: 0.4 }] },
      ],
    })
  })

  it('keeps tags already on the document, without the inbox tag or duplicates', () => {
    const s = initialEditState(makeDetail({ document: { tagIds: [1, 4, 2] }, suggestion: { tagIds: [2, 3], proposedTags: [] } }))
    expect(s.tags).toEqual([
      { kind: 'existing', id: 4 },
      { kind: 'existing', id: 2 },
      { kind: 'existing', id: 3 },
    ])
  })

  it('marks auto-matched entries', () => {
    const s = initialEditState(makeDetail({ suggestion: { matchedNotes: { Telekom: 'Deutsche Telekom AG', Rechnungen: 'Rechnung' } } }))
    expect(s.correspondent).toEqual({ kind: 'existing', id: 10, matchedFrom: 'Telekom' })
    expect(s.tags[0]).toEqual({ kind: 'existing', id: 2, matchedFrom: 'Rechnungen' })
  })

  it('turns a proposed correspondent into a NEW entry', () => {
    const s = initialEditState(
      makeDetail({ suggestion: { correspondentId: null, proposedCorrespondent: { name: 'Neue GmbH', nearest: [] } } }),
    )
    expect(s.correspondent).toEqual({ kind: 'new', name: 'Neue GmbH', nearest: [] })
  })

  it('falls back to the current document values without a ready suggestion', () => {
    const expected = { title: 'scan_1', correspondent: { kind: 'existing', id: 11 }, tags: [{ kind: 'existing', id: 4 }] }
    const document = { correspondentId: 11, tagIds: [1, 4] }
    expect(initialEditState(makeDetail({ document, suggestion: { status: 'error', error: 'x' } }))).toEqual(expected)
    expect(initialEditState(makeDetail({ document, suggestion: null }))).toEqual(expected)
  })
})

describe('tag operations', () => {
  const tags: TagEntry[] = [
    { kind: 'existing', id: 2 },
    { kind: 'new', name: 'Mobilfunk', nearest: [] },
  ]

  it('adds existing tags once and removes by index', () => {
    expect(addExistingTag(tags, 2)).toBe(tags)
    expect(addExistingTag(tags, 4)).toEqual([...tags, { kind: 'existing', id: 4 }])
    expect(removeTagAt(tags, 0)).toEqual([tags[1]])
  })

  it('replaces a NEW tag in place, without duplicating', () => {
    expect(replaceNewTag(tags, 1, 3)).toEqual([{ kind: 'existing', id: 2 }, { kind: 'existing', id: 3 }])
    expect(replaceNewTag(tags, 1, 2)).toEqual([{ kind: 'existing', id: 2 }])
  })

  it('adds a typed name as existing tag when it matches, else as NEW with nearest', () => {
    expect(addNewTag([], 'rechnung', options)).toEqual([{ kind: 'existing', id: 2 }])
    expect(addNewTag(tags, 'mobilfunk', options)).toBe(tags)
    expect(addNewTag([], '  ', options)).toEqual([])
    const added = addNewTag([], 'Rechnungen', options)
    expect(added[0]).toMatchObject({ kind: 'new', name: 'Rechnungen' })
    expect(added[0]!.kind === 'new' && added[0]!.nearest[0]?.name).toBe('Rechnung')
  })
})

describe('toApplyRequest / canApply', () => {
  it('maps entries to ids and names', () => {
    const s = { title: '  T  ', correspondent: { kind: 'new' as const, name: ' Neu ', nearest: [] }, tags: [{ kind: 'existing' as const, id: 2 }, { kind: 'new' as const, name: 'X', nearest: [] }] }
    expect(toApplyRequest(s, 'm')).toEqual({ title: 'T', correspondent: { name: 'Neu' }, tags: [{ id: 2 }, { name: 'X' }], expectedModified: 'm' })
    expect(toApplyRequest({ ...s, correspondent: null }, 'm').correspondent).toBeNull()
  })

  it('requires a title and a name for a new correspondent', () => {
    expect(canApply({ title: 'T', correspondent: null, tags: [] })).toBe(true)
    expect(canApply({ title: ' ', correspondent: null, tags: [] })).toBe(false)
    expect(canApply({ title: 'T', correspondent: { kind: 'new', name: '', nearest: [] }, tags: [] })).toBe(false)
  })
})

describe('applyMissing', () => {
  it('turns deleted entries into NEW entries with their old names', () => {
    const detail = makeDetail()
    const s = applyMissing(
      { title: 'T', correspondent: { kind: 'existing', id: 10 }, tags: [{ kind: 'existing', id: 2 }, { kind: 'existing', id: 4 }] },
      { missingTagIds: [2], missingCorrespondentId: 10 },
      detail.vocabulary,
    )
    expect(s.correspondent).toMatchObject({ kind: 'new', name: 'Deutsche Telekom AG' })
    expect(s.tags).toEqual([{ kind: 'new', name: 'Rechnung', nearest: expect.any(Array) }, { kind: 'existing', id: 4 }])
  })
})

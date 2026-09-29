import { describe, expect, it, vi } from 'vitest'
import {
  hashVocabulary,
  InboxTagError,
  loadVocabulary,
  resolveInboxTag,
  selectableTags,
} from '../../src/paperless/vocabulary'
import { makeVocabulary } from '../helpers/fixtures'

describe('resolveInboxTag', () => {
  const tags = makeVocabulary().tags

  it('uses the tag flagged as inbox tag by default', () => {
    expect(resolveInboxTag(tags, null).id).toBe(1)
  })

  it('resolves INBOX_TAG by id or case-insensitive name', () => {
    expect(resolveInboxTag(tags, '4').name).toBe('Versicherung')
    expect(resolveInboxTag(tags, 'rechnung').id).toBe(2)
  })

  it('throws InboxTagError when nothing matches', () => {
    expect(() => resolveInboxTag(tags, 'Nope')).toThrow(InboxTagError)
    expect(() => resolveInboxTag(tags.filter((t) => !t.isInboxTag), null)).toThrow(/INBOX_TAG/)
  })
})

describe('loadVocabulary', () => {
  it('loads tags and correspondents and resolves the inbox tag', async () => {
    const v = makeVocabulary()
    const client = { listTags: vi.fn(async () => v.tags), listCorrespondents: vi.fn(async () => v.correspondents) }
    expect(await loadVocabulary(client, null)).toEqual(v)
  })
})

describe('selectableTags', () => {
  it('excludes the inbox tag', () => {
    expect(selectableTags(makeVocabulary()).map((t) => t.id)).toEqual([2, 3, 4, 5])
  })
})

describe('hashVocabulary', () => {
  it('ignores document counts and order', () => {
    const a = makeVocabulary()
    const b = makeVocabulary()
    b.tags.reverse()
    b.tags[0]!.documentCount = 999
    expect(hashVocabulary(a)).toBe(hashVocabulary(b))
  })

  it('changes when a name changes or a tag is added', () => {
    const a = makeVocabulary()
    const renamed = makeVocabulary()
    renamed.tags[1]!.name = 'Rechnungen'
    const added = makeVocabulary()
    added.correspondents.push({ id: 99, name: 'Neu', documentCount: 0 })
    expect(hashVocabulary(renamed)).not.toBe(hashVocabulary(a))
    expect(hashVocabulary(added)).not.toBe(hashVocabulary(a))
  })
})

import { describe, expect, it, vi } from 'vitest'
import { loadExamples, toExample } from '../../src/suggest/examples'
import { makeDocument, makeVocabulary } from '../helpers/fixtures'

const v = makeVocabulary()
const filed = (id: number, correspondent: number | null = 10) =>
  makeDocument({ id, title: `Filed ${id}`, correspondent, tags: [2, 3], content: `content ${id}` })

describe('toExample', () => {
  it('resolves names and drops the inbox tag', () => {
    expect(toExample(makeDocument({ correspondent: 10, tags: [1, 2], created: '2026-09-12' }), v)).toMatchObject({
      title: 'scan_0001',
      createdDate: '2026-09-12',
      correspondent: 'Deutsche Telekom AG',
      tags: ['Rechnung'],
    })
  })
})

describe('loadExamples', () => {
  it('uses documents of the correspondent named in the text', async () => {
    const listFiledDocuments = vi.fn(async () => [filed(1), filed(2), filed(3), filed(4)])
    const examples = await loadExamples({ listFiledDocuments }, v, 'Deutsche Telekom AG Rechnung', new Set())
    expect(listFiledDocuments).toHaveBeenCalledWith({ inboxTagId: 1, correspondentId: 10, limit: 3 })
    expect(examples.map((e) => e.title)).toEqual(['Filed 1', 'Filed 2', 'Filed 3'])
    expect(examples[0]!.tags).toEqual(['Rechnung', 'Telefon/Internet'])
  })

  it('falls back to recent documents when no correspondent is recognised', async () => {
    const listFiledDocuments = vi.fn(async () => [filed(7, 11)])
    await loadExamples({ listFiledDocuments }, v, 'unknown sender', new Set())
    expect(listFiledDocuments).toHaveBeenCalledWith({ inboxTagId: 1, limit: 3 })
  })

  it('excludes given ids and falls back when all matches are excluded', async () => {
    const listFiledDocuments = vi
      .fn()
      .mockResolvedValueOnce([filed(1)])
      .mockResolvedValueOnce([filed(1), filed(8, 11)])
    const examples = await loadExamples({ listFiledDocuments }, v, 'Deutsche Telekom AG', new Set([1]))
    expect(listFiledDocuments).toHaveBeenNthCalledWith(1, { inboxTagId: 1, correspondentId: 10, limit: 4 })
    expect(listFiledDocuments).toHaveBeenNthCalledWith(2, { inboxTagId: 1, limit: 4 })
    expect(examples.map((e) => e.title)).toEqual(['Filed 8'])
  })
})

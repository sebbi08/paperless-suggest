import { describe, expect, it } from 'vitest'
import { nameSimilarity, normalizeName, rankMatches } from '../../src/suggest/normalize'

describe('normalizeName', () => {
  it('lowercases, folds umlauts and strips punctuation', () => {
    expect(normalizeName('Stadtwerke München')).toBe('stadtwerke muenchen')
    expect(normalizeName('Straße & Söhne')).toBe('strasse soehne')
    expect(normalizeName('Café Olé')).toBe('cafe ole')
  })

  it('removes legal suffixes', () => {
    expect(normalizeName('Deutsche Telekom AG')).toBe('deutsche telekom')
    expect(normalizeName('Müller GmbH & Co. KG')).toBe('mueller')
    expect(normalizeName('Acme Inc.')).toBe('acme')
  })

  it('keeps a name that consists only of a suffix-like token', () => {
    expect(normalizeName('AG')).toBe('ag')
  })
})

describe('nameSimilarity', () => {
  it('is 1 for names equal after normalization', () => {
    expect(nameSimilarity('Stadtwerke München GmbH', 'stadtwerke muenchen')).toBe(1)
  })

  it('is 0.9 when all tokens of the shorter name are contained in the longer', () => {
    expect(nameSimilarity('Telekom', 'Deutsche Telekom AG')).toBe(0.9)
  })

  it('scores near-identical words high', () => {
    expect(nameSimilarity('Rechnungen', 'Rechnung')).toBeGreaterThanOrEqual(0.85)
  })

  it('scores unrelated words low', () => {
    expect(nameSimilarity('Versicherung', 'Rechnung')).toBeLessThan(0.5)
  })

  it('is 0 for empty input', () => {
    expect(nameSimilarity('', 'Rechnung')).toBe(0)
  })
})

describe('rankMatches', () => {
  const tags = [
    { id: 1, name: 'Rechnung' },
    { id: 2, name: 'Versicherung' },
    { id: 3, name: 'Telefon/Internet' },
    { id: 4, name: 'Steuer' },
  ]

  it('returns the best matches first, limited', () => {
    const r = rankMatches('Rechnungen', tags, 2)
    expect(r).toHaveLength(2)
    expect(r[0]).toMatchObject({ id: 1, name: 'Rechnung' })
    expect(r[0]!.score).toBeGreaterThan(r[1]!.score)
  })

  it('drops candidates with score 0', () => {
    expect(rankMatches('xyz', tags)).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'
import { buildPrompt, guessCorrespondent, truncateContent } from '../../src/suggest/prompt'
import { makeVocabulary } from '../helpers/fixtures'

describe('truncateContent', () => {
  it('trims and keeps short content', () => {
    expect(truncateContent('  abc  ', 10)).toBe('abc')
  })

  it('cuts long content and marks the cut', () => {
    expect(truncateContent('abcdef', 3)).toBe('abc\n[…]')
  })
})

describe('guessCorrespondent', () => {
  const { correspondents } = makeVocabulary()

  it('finds a correspondent named in the text, ignoring case, umlauts and legal suffix', () => {
    expect(guessCorrespondent('Ihre Stadtwerke Muenchen informieren', correspondents)?.id).toBe(11)
    expect(guessCorrespondent('DEUTSCHE TELEKOM AG, Bonn', correspondents)?.id).toBe(10)
  })

  it('prefers the longest match', () => {
    const cs = [
      { id: 1, name: 'Allianz', documentCount: 1 },
      { id: 2, name: 'Allianz Versicherung', documentCount: 1 },
    ]
    expect(guessCorrespondent('Allianz Versicherung AG', cs)?.id).toBe(2)
  })

  it('returns null when nothing matches or names are too short', () => {
    expect(guessCorrespondent('Hallo Welt', correspondents)).toBeNull()
    expect(guessCorrespondent('ab cd', [{ id: 1, name: 'AB', documentCount: 0 }])).toBeNull()
  })
})

describe('buildPrompt', () => {
  const vocabulary = makeVocabulary()

  it('lists correspondents and tags with counts, most used first, without the inbox tag', () => {
    const { system } = buildPrompt({ content: 'x', vocabulary, examples: [] })
    expect(system).toContain('- Deutsche Telekom AG')
    expect(system).toContain('- Rechnung (120)')
    expect(system.indexOf('Rechnung (120)')).toBeLessThan(system.indexOf('Versicherung (30)'))
    expect(system).not.toContain('Inbox')
    expect(system).toMatch(/propose a new one only if/i)
  })

  it('says (none) for an empty vocabulary', () => {
    const { system } = buildPrompt({
      content: 'x',
      vocabulary: { inboxTagId: 1, tags: [], correspondents: [] },
      examples: [],
    })
    expect(system.match(/\(none\)/g)).toHaveLength(2)
  })

  it('includes truncated examples and the document', () => {
    const { user } = buildPrompt({
      content: 'THE DOCUMENT',
      vocabulary,
      examples: [{ title: 'Alte Rechnung', correspondent: 'Deutsche Telekom AG', tags: ['Rechnung'], content: 'E'.repeat(2000) }],
    })
    expect(user).toContain('### Example 1')
    expect(user).toContain('Filed as: {"title":"Alte Rechnung","correspondent":"Deutsche Telekom AG","tags":["Rechnung"]}')
    expect(user).not.toContain('E'.repeat(801))
    expect(user).toContain('### Document to file')
    expect(user.trimEnd().endsWith('THE DOCUMENT\n"""')).toBe(true)
  })
})

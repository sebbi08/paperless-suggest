import { describe, expect, it } from 'vitest'
import { checkTitle, detectLanguage, summarize, type EvalCase } from '../../src/eval/metrics'

const truth = (id: number, correspondentId: number, tagIds: number[]) => ({
  documentId: id,
  title: 't',
  createdDate: '2026-09-14',
  correspondentId,
  tagIds,
  content: 'Rechnung vom 14.09.2026 für September 2026',
})

const ok = (
  correspondentId: number | null,
  tagIds: number[],
  proposed = 0,
  title = 'Telekom Rechnung September 2026',
  createdDate: string | null = '2026-09-14',
) => ({
  kind: 'ok' as const,
  suggestion: {
    title,
    createdDate,
    correspondentId,
    proposedCorrespondent: null,
    tagIds,
    proposedTags: Array.from({ length: proposed }, (_, i) => ({ name: `new${i}`, nearest: [] })),
    matchedNotes: {},
    model: 'm',
  },
})

describe('detectLanguage', () => {
  it('detects German and English by common words', () => {
    expect(detectLanguage('Ihre Rechnung für den Monat')).toBe('de')
    expect(detectLanguage('Your invoice for the month')).toBe('en')
    expect(detectLanguage('Telekom 2026')).toBe('unknown')
  })
})

describe('checkTitle', () => {
  const content = 'Deutsche Telekom Rechnung vom 14.09.2026 für den Monat September'

  it('passes a good title', () => {
    expect(checkTitle('Telekom Rechnung September 2026', content)).toEqual({ lengthOk: true, languageOk: true, datesOk: true })
  })

  it('flags invented years, dates and months', () => {
    expect(checkTitle('Telekom Rechnung 2025', content).datesOk).toBe(false)
    expect(checkTitle('Telekom Rechnung 01.02.2026', content).datesOk).toBe(false)
    expect(checkTitle('Telekom Rechnung Oktober', content).datesOk).toBe(false)
  })

  it('accepts a month given numerically in the text', () => {
    expect(checkTitle('Telekom Rechnung Sep 2026', content).datesOk).toBe(true)
  })

  it('flags wrong language and bad length', () => {
    expect(checkTitle('Telekom invoice for September', content).languageOk).toBe(false)
    expect(checkTitle('x'.repeat(81), content).lengthOk).toBe(false)
    expect(checkTitle('ab', content).lengthOk).toBe(false)
  })
})

describe('summarize', () => {
  it('computes accuracy, micro P/R/F1, new-name and failure rates', () => {
    const cases: EvalCase[] = [
      { truth: truth(1, 10, [2, 3]), outcome: ok(10, [2]), seconds: 2 },
      { truth: truth(2, 11, [2]), outcome: ok(10, [2, 4], 1, undefined, '2026-09-01'), seconds: 4 },
      { truth: truth(3, 12, [5]), outcome: { kind: 'error', error: 'bad', model: 'm' }, seconds: 6 },
      { truth: truth(4, 12, [5]), outcome: { kind: 'exception', error: 'down' }, seconds: 0 },
    ]
    const s = summarize('m', cases)
    expect(s.model).toBe('m')
    expect(s.documents).toBe(4)
    expect(s.correspondentAccuracy).toBe(0.25)
    expect(s.dateAccuracy).toBe(0.25)
    // predicted: {2}, {2,4} -> 3; true positives: 2; truth total: 2 + 1 + 1 + 1 = 5
    expect(s.tagPrecision).toBeCloseTo(2 / 3)
    expect(s.tagRecall).toBeCloseTo(2 / 5)
    expect(s.tagF1).toBeCloseTo((2 * (2 / 3) * (2 / 5)) / (2 / 3 + 2 / 5))
    expect(s.newNameRate).toBe(0.5)
    expect(s.failureRate).toBe(0.5)
    expect(s.titleChecksPassRate).toBe(1)
    expect(s.avgSeconds).toBe(3)
  })

  it('handles an empty or all-failed run without NaN', () => {
    const s = summarize('m', [{ truth: truth(1, 10, [2]), outcome: { kind: 'no_text' }, seconds: 1 }])
    expect(s).toMatchObject({ dateAccuracy: 0, tagPrecision: 0, tagRecall: 0, tagF1: 0, newNameRate: 0, failureRate: 1, titleChecksPassRate: 0 })
    expect(summarize('m', []).avgSeconds).toBe(0)
  })
})

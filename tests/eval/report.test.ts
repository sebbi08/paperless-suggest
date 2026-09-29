import { describe, expect, it } from 'vitest'
import type { ModelSummary } from '../../src/eval/metrics'
import { renderReport } from '../../src/eval/report'

const summary = (model: string, f1: number): ModelSummary => ({
  model,
  documents: 2,
  correspondentAccuracy: 0.5,
  tagPrecision: 0.8,
  tagRecall: 0.6,
  tagF1: f1,
  newNameRate: 0.1,
  failureRate: 0,
  titleChecksPassRate: 1,
  avgSeconds: 3.25,
})

describe('renderReport', () => {
  const html = renderReport({
    generatedAt: '2026-09-29T10:00:00Z',
    summaries: [summary('qwen3-14b', 0.7), summary('gemma-3-12b', 0.65)],
    rows: [
      {
        documentId: 7,
        truth: { title: 'Rechnung <Telekom>', correspondent: 'Deutsche Telekom AG', tags: ['Rechnung'] },
        byModel: {
          'qwen3-14b': { title: 'Telekom Rechnung', correspondent: 'Deutsche Telekom AG', tags: ['Rechnung'], proposed: ['Mobilfunk'], error: null, seconds: 3, checks: { lengthOk: true, languageOk: true, datesOk: false } },
          'gemma-3-12b': { title: null, correspondent: null, tags: [], proposed: [], error: 'Invalid <output>', seconds: 1, checks: null },
        },
      },
    ],
  })

  it('renders a summary row per model with percentages', () => {
    expect(html).toContain('<td>qwen3-14b</td>')
    expect(html).toContain('70.0%')
    expect(html).toContain('3.3 s')
  })

  it('shows per-document results side by side and escapes HTML', () => {
    expect(html).toContain('Rechnung &lt;Telekom&gt;')
    expect(html).toContain('Invalid &lt;output&gt;')
    expect(html).toContain('NEW: Mobilfunk')
    expect(html).toContain('dates?')
    expect(html).not.toContain('<Telekom>')
  })
})

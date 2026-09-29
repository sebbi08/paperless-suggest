import { describe, expect, it, vi } from 'vitest'
import type { LlmClient, LlmRequest } from '../../src/llm/client'
import { parseArgs, pickSample, runEval } from '../../src/eval/run'
import { fakePaperless } from '../helpers/fakes'
import { makeDocument, makeVocabulary } from '../helpers/fixtures'

describe('parseArgs', () => {
  it('parses models, sample and output dir', () => {
    expect(parseArgs(['--models', 'a,b', '--sample', '10', '--out', 'x'])).toEqual({ models: ['a', 'b'], sample: 10, outDir: 'x' })
    expect(parseArgs(['--models=a'])).toEqual({ models: ['a'], sample: 50, outDir: 'eval-results' })
  })

  it('uses a custom default output dir when --out is absent', () => {
    expect(parseArgs(['--models', 'a'], '/data/eval-results').outDir).toBe('/data/eval-results')
    expect(parseArgs(['--models', 'a', '--out', 'x'], '/data/eval-results').outDir).toBe('x')
  })

  it('requires models and a positive sample', () => {
    expect(() => parseArgs([])).toThrow(/--models/)
    expect(() => parseArgs(['--models', 'a', '--sample', '0'])).toThrow(/--sample/)
  })
})

describe('pickSample', () => {
  const doc = (id: number, correspondent: number | null, tags = [2], content = 'text') =>
    makeDocument({ id, correspondent, tags, content })

  it('keeps only usable documents and spreads the sample across correspondents', () => {
    const docs = [
      doc(1, 10), doc(2, 10), doc(3, 10), doc(4, 11), doc(5, 12),
      doc(6, null), doc(7, 10, [1]), doc(8, 10, [2], '  '),
    ]
    expect(pickSample(docs, 1, 4).map((d) => d.id)).toEqual([3, 4, 5, 2])
  })
})

describe('runEval', () => {
  it('runs every model over the sample and never shows a sample doc as example', async () => {
    const v = makeVocabulary()
    const sampleDocs = [
      makeDocument({ id: 1, correspondent: 10, tags: [2], content: 'SAMPLE-ONE Deutsche Telekom AG' }),
      makeDocument({ id: 2, correspondent: 10, tags: [2, 3], content: 'SAMPLE-TWO Deutsche Telekom AG' }),
    ]
    const other = makeDocument({ id: 9, correspondent: 10, tags: [2], content: 'OTHER-DOC', title: 'Other' })
    const paperless = fakePaperless({
      listTags: async () => v.tags,
      listCorrespondents: async () => v.correspondents,
      // the large fetch feeds the sample; the small per-document fetches feed few-shot examples
      listFiledDocuments: async ({ limit }) => (limit >= 1000 ? sampleDocs : [...sampleDocs, other]),
    })
    const prompts: LlmRequest[] = []
    const llm: LlmClient = {
      health: vi.fn(),
      complete: vi.fn(async (req: LlmRequest) => {
        prompts.push(req)
        return {
          model: req.model ?? '?',
          content: JSON.stringify({ title: 'Telekom Rechnung', correspondent: 'Deutsche Telekom AG', proposed_new_correspondent: null, tags: ['Rechnung'], proposed_new_tags: [] }),
        }
      }),
    }
    const { summaries, rows } = await runEval({ paperless, llm, inboxTag: null, maxContentChars: 6000, matchThreshold: 0.85, models: ['a', 'b'], sample: 2 })

    expect(summaries.map((s) => s.model)).toEqual(['a', 'b'])
    expect(summaries[0]).toMatchObject({ documents: 2, correspondentAccuracy: 1, failureRate: 0, tagPrecision: 1 })
    expect(summaries[0]!.tagRecall).toBeCloseTo(2 / 3)
    expect(prompts).toHaveLength(4)
    for (const p of prompts) {
      const examples = p.user.split('### Document to file')[0]!
      expect(examples).toContain('OTHER-DOC')
      expect(examples).not.toContain('SAMPLE-')
    }
    expect(rows.map((r) => r.documentId)).toEqual([2, 1])
    expect(rows[0]!.truth).toEqual({ title: 'scan_0001', correspondent: 'Deutsche Telekom AG', tags: ['Rechnung', 'Telefon/Internet'] })
    expect(rows[0]!.byModel.a).toMatchObject({ title: 'Telekom Rechnung', correspondent: 'Deutsche Telekom AG', tags: ['Rechnung'], error: null })
  })
})

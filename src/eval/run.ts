import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ConfigError, loadConfig, type Config } from '../config'
import { createLlmClient, type LlmClient } from '../llm/client'
import { createPaperlessClient, type PaperlessClient } from '../paperless/client'
import type { PaperlessDocument } from '../paperless/types'
import { loadVocabulary } from '../paperless/vocabulary'
import { loadExamples } from '../suggest/examples'
import { createSuggester } from '../suggest/suggester'
import type { Example } from '../suggest/types'
import { checkTitle, summarize, type EvalCase, type EvalOutcome, type ModelSummary } from './metrics'
import { renderReport, type ReportRow } from './report'

const USAGE = 'Usage: npm run eval -- --models <id,id,...> [--sample 50] [--out eval-results]'
const FILED_FETCH_LIMIT = 1000

export interface EvalArgs {
  models: string[]
  sample: number
  outDir: string
}

export function parseArgs(argv: string[], defaultOutDir = 'eval-results'): EvalArgs {
  const values = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (!arg.startsWith('--')) continue
    const eq = arg.indexOf('=')
    if (eq > 0) values.set(arg.slice(2, eq), arg.slice(eq + 1))
    else values.set(arg.slice(2), argv[++i] ?? '')
  }
  const models = (values.get('models') ?? '').split(',').map((m) => m.trim()).filter(Boolean)
  if (models.length === 0) throw new Error(`--models is required.\n${USAGE}`)
  const sample = Number(values.get('sample') ?? 50)
  if (!Number.isInteger(sample) || sample <= 0) throw new Error(`--sample must be a positive integer.\n${USAGE}`)
  return { models, sample, outDir: values.get('out') ?? defaultOutDir }
}

/** Filed documents with correspondent, at least one real tag and text; round-robin across correspondents, newest first. */
export function pickSample(docs: PaperlessDocument[], inboxTagId: number, n: number): PaperlessDocument[] {
  const groups = new Map<number, PaperlessDocument[]>()
  for (const d of docs) {
    if (d.correspondent === null || !d.content.trim()) continue
    if (!d.tags.some((t) => t !== inboxTagId)) continue
    const list = groups.get(d.correspondent) ?? []
    list.push(d)
    groups.set(d.correspondent, list)
  }
  const queues = [...groups.entries()].sort(([a], [b]) => a - b).map(([, list]) => list.sort((a, b) => b.id - a.id))
  const out: PaperlessDocument[] = []
  while (out.length < n && queues.some((q) => q.length > 0)) {
    for (const q of queues) {
      const next = q.shift()
      if (next && out.length < n) out.push(next)
    }
  }
  return out
}

export async function runEval(deps: {
  paperless: PaperlessClient
  llm: LlmClient
  inboxTag: string | null
  maxContentChars: number
  matchThreshold: number
  models: string[]
  sample: number
  log?: (line: string) => void
}): Promise<{ summaries: ModelSummary[]; rows: ReportRow[] }> {
  const log = deps.log ?? (() => {})
  const vocab = await loadVocabulary(deps.paperless, deps.inboxTag)
  const filed = await deps.paperless.listFiledDocuments({ inboxTagId: vocab.inboxTagId, limit: FILED_FETCH_LIMIT })
  const sample = pickSample(filed, vocab.inboxTagId, deps.sample)
  const exclude = new Set(sample.map((d) => d.id))
  log(`Sample: ${sample.length} documents from ${new Set(sample.map((d) => d.correspondent)).size} correspondents`)

  const tagName = new Map(vocab.tags.map((t) => [t.id, t.name]))
  const correspondentName = new Map(vocab.correspondents.map((c) => [c.id, c.name]))
  const names = (ids: number[]) => ids.map((id) => tagName.get(id) ?? `#${id}`)

  const examples = new Map<number, Example[]>()
  for (const d of sample) examples.set(d.id, await loadExamples(deps.paperless, vocab, d.content, exclude))

  const rows: ReportRow[] = sample.map((d) => ({
    documentId: d.id,
    truth: {
      title: d.title,
      createdDate: d.created,
      correspondent: correspondentName.get(d.correspondent!) ?? '',
      tags: names(d.tags.filter((t) => t !== vocab.inboxTagId)),
    },
    byModel: {},
  }))

  const suggester = createSuggester({ llm: deps.llm, maxContentChars: deps.maxContentChars, matchThreshold: deps.matchThreshold })
  const summaries: ModelSummary[] = []
  for (const model of deps.models) {
    const cases: EvalCase[] = []
    for (const [i, d] of sample.entries()) {
      const started = performance.now()
      let outcome: EvalOutcome
      try {
        outcome = await suggester.suggest({ content: d.content, vocabulary: vocab, examples: examples.get(d.id) ?? [], model })
      } catch (e) {
        outcome = { kind: 'exception', error: (e as Error).message }
      }
      const seconds = (performance.now() - started) / 1000
      const truthTags = d.tags.filter((t) => t !== vocab.inboxTagId)
      cases.push({ truth: { documentId: d.id, title: d.title, createdDate: d.created, correspondentId: d.correspondent!, tagIds: truthTags, content: d.content }, outcome, seconds })
      const s = outcome.kind === 'ok' ? outcome.suggestion : null
      rows[i]!.byModel[model] = {
        title: s?.title ?? null,
        createdDate: s?.createdDate ?? null,
        correspondent: s?.correspondentId != null ? (correspondentName.get(s.correspondentId) ?? null) : null,
        tags: s ? names(s.tagIds) : [],
        proposed: s ? [...(s.proposedCorrespondent ? [s.proposedCorrespondent.name] : []), ...s.proposedTags.map((p) => p.name)] : [],
        error: outcome.kind === 'error' || outcome.kind === 'exception' ? outcome.error : outcome.kind === 'no_text' ? 'no text' : null,
        seconds,
        checks: s ? checkTitle(s.title, d.content) : null,
      }
      log(`[${model}] ${i + 1}/${sample.length} #${d.id} ${outcome.kind} ${seconds.toFixed(1)}s`)
    }
    summaries.push(summarize(model, cases))
  }
  return { summaries, rows }
}

async function main(): Promise<void> {
  let args: EvalArgs
  try {
    const defaultOut = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'eval-results') : 'eval-results'
    args = parseArgs(process.argv.slice(2), defaultOut)
    mkdirSync(args.outDir, { recursive: true })
  } catch (e) {
    console.error((e as Error).message)
    process.exit(1)
  }
  let config: Config
  try {
    config = loadConfig(process.env, { requireAuth: false })
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message)
      process.exit(1)
    }
    throw e
  }
  const { summaries, rows } = await runEval({
    paperless: createPaperlessClient({ baseUrl: config.paperlessUrl, token: config.paperlessToken }),
    llm: createLlmClient({ baseUrl: config.llmBaseUrl, model: null }),
    inboxTag: config.inboxTag,
    maxContentChars: config.maxContentChars,
    matchThreshold: config.newNameMatchThreshold,
    models: args.models,
    sample: args.sample,
    log: (line) => console.error(line),
  })
  const generatedAt = new Date().toISOString()
  const file = path.join(args.outDir, `${generatedAt.replace(/[:.]/g, '-')}.html`)
  writeFileSync(file, renderReport({ generatedAt, summaries, rows }))
  console.table(
    summaries.map((s) => ({
      model: s.model,
      corrAcc: s.correspondentAccuracy.toFixed(3),
      dateAcc: s.dateAccuracy.toFixed(3),
      tagF1: s.tagF1.toFixed(3),
      newNames: s.newNameRate.toFixed(3),
      failures: s.failureRate.toFixed(3),
      titles: s.titleChecksPassRate.toFixed(3),
      secPerDoc: s.avgSeconds.toFixed(1),
    })),
  )
  console.log(`Report: ${file}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}

import type { SuggestResult } from '../suggest/types'

export interface GroundTruth {
  documentId: number
  title: string
  createdDate: string
  correspondentId: number
  tagIds: number[]
  content: string
}

export type EvalOutcome = SuggestResult | { kind: 'exception'; error: string }

export interface EvalCase {
  truth: GroundTruth
  outcome: EvalOutcome
  seconds: number
}

export interface TitleChecks {
  lengthOk: boolean
  languageOk: boolean
  datesOk: boolean
}

export interface ModelSummary {
  model: string
  documents: number
  correspondentAccuracy: number
  /** suggested issue date equals the filed document's date */
  dateAccuracy: number
  tagPrecision: number
  tagRecall: number
  tagF1: number
  newNameRate: number
  failureRate: number
  titleChecksPassRate: number
  avgSeconds: number
}

const DE_WORDS = new Set([
  'der', 'die', 'das', 'und', 'ist', 'nicht', 'mit', 'für', 'von', 'vom', 'den', 'dem', 'des', 'ihre', 'ihr',
  'wir', 'zu', 'auf', 'im', 'ein', 'eine', 'bei', 'rechnung', 'vertrag', 'bescheid', 'kündigung', 'versicherung',
  'abrechnung', 'mahnung', 'lohnabrechnung', 'kontoauszug', 'monat', 'jahr',
])
const EN_WORDS = new Set([
  'the', 'and', 'is', 'not', 'with', 'for', 'of', 'to', 'your', 'we', 'you', 'on', 'in', 'a', 'an', 'at', 'from',
  'invoice', 'contract', 'statement', 'receipt', 'policy', 'letter', 'bill', 'month', 'year',
])

export function detectLanguage(text: string): 'de' | 'en' | 'unknown' {
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? []
  let de = 0
  let en = 0
  for (const w of words) {
    if (DE_WORDS.has(w)) de++
    if (EN_WORDS.has(w)) en++
  }
  if (de === en) return 'unknown'
  return de > en ? 'de' : 'en'
}

const MONTHS: [RegExp, number][] = [
  [/\b(januar|january|jan)\b/i, 1],
  [/\b(februar|february|feb)\b/i, 2],
  [/\b(märz|maerz|march|mar)\b/i, 3],
  [/\b(april|apr)\b/i, 4],
  [/\b(mai|may)\b/i, 5],
  [/\b(juni|june|jun)\b/i, 6],
  [/\b(juli|july|jul)\b/i, 7],
  [/\b(august|aug)\b/i, 8],
  [/\b(september|sept|sep)\b/i, 9],
  [/\b(oktober|october|okt|oct)\b/i, 10],
  [/\b(november|nov)\b/i, 11],
  [/\b(dezember|december|dez|dec)\b/i, 12],
]

function datesOk(title: string, content: string): boolean {
  for (const year of title.match(/\b(19|20)\d{2}\b/g) ?? []) if (!content.includes(year)) return false
  for (const date of title.match(/\b\d{1,2}\.\d{1,2}\.(\d{2,4})?/g) ?? []) if (!content.includes(date)) return false
  for (const [pattern, month] of MONTHS) {
    if (!pattern.test(title)) continue
    const numeric = new RegExp(`\\.0?${month}\\.`)
    if (!pattern.test(content) && !numeric.test(content)) return false
  }
  return true
}

export function checkTitle(title: string, content: string): TitleChecks {
  const t = detectLanguage(title)
  const c = detectLanguage(content)
  return {
    lengthOk: title.trim().length >= 3 && title.length <= 80,
    languageOk: t === 'unknown' || c === 'unknown' || t === c,
    datesOk: datesOk(title, content),
  }
}

const ratio = (a: number, b: number) => (b === 0 ? 0 : a / b)

export function summarize(model: string, cases: EvalCase[]): ModelSummary {
  let correct = 0
  let datesCorrect = 0
  let truePositives = 0
  let predicted = 0
  let truthTotal = 0
  let succeeded = 0
  let withProposals = 0
  let titlesOk = 0
  let seconds = 0
  for (const c of cases) {
    seconds += c.seconds
    truthTotal += c.truth.tagIds.length
    if (c.outcome.kind !== 'ok') continue
    const s = c.outcome.suggestion
    succeeded++
    if (s.correspondentId === c.truth.correspondentId) correct++
    if (s.createdDate === c.truth.createdDate) datesCorrect++
    predicted += s.tagIds.length
    truePositives += s.tagIds.filter((id) => c.truth.tagIds.includes(id)).length
    if (s.proposedCorrespondent || s.proposedTags.length > 0) withProposals++
    const checks = checkTitle(s.title, c.truth.content)
    if (checks.lengthOk && checks.languageOk && checks.datesOk) titlesOk++
  }
  const precision = ratio(truePositives, predicted)
  const recall = ratio(truePositives, truthTotal)
  return {
    model,
    documents: cases.length,
    correspondentAccuracy: ratio(correct, cases.length),
    dateAccuracy: ratio(datesCorrect, cases.length),
    tagPrecision: precision,
    tagRecall: recall,
    tagF1: ratio(2 * precision * recall, precision + recall),
    newNameRate: ratio(withProposals, succeeded),
    failureRate: ratio(cases.length - succeeded, cases.length),
    titleChecksPassRate: ratio(titlesOk, succeeded),
    avgSeconds: ratio(seconds, cases.length),
  }
}

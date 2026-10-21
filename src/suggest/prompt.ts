import { selectableTags } from '../paperless/vocabulary'
import type { PaperlessCorrespondent, Vocabulary } from '../paperless/types'
import { normalizeName } from './normalize'
import type { Example } from './types'

export const EXAMPLE_CHARS = 800

const RULES = `You file scanned documents in a Paperless-ngx archive. For the document you are given, suggest a title, the issue date, a correspondent and tags.

Rules:
- Correspondent: the sender or issuer of the document. Pick one from the list of existing correspondents. Use null only if none of them fits; then put a new name in proposed_new_correspondent.
- Tags: pick all fitting tags from the list of existing tags. Prefer tags that are used often. Use existing tags and correspondents; propose a new one only if nothing in the list fits at all, and never propose a name that means the same as an existing one. At most 2 new tags.
- Title: in the language of the document, at most 80 characters, shaped like "<Correspondent> <document type> <subject or period>", for example "Telekom Rechnung Mobilfunk September 2026". Only use dates that appear in the document.
- created_date: the date the document was issued (invoice date, letter date, date of the notice) as YYYY-MM-DD. Only use a date that appears in the document; not a due date, a delivery date or a billing period. Use null if the document has no issue date.
- Answer with JSON only.`

export function truncateContent(content: string, maxChars: number): string {
  const t = content.trim()
  return t.length <= maxChars ? t : `${t.slice(0, maxChars)}\n[…]`
}

export function guessCorrespondent(
  content: string,
  correspondents: PaperlessCorrespondent[],
): PaperlessCorrespondent | null {
  const haystack = ` ${normalizeName(content)} `
  let best: { c: PaperlessCorrespondent; length: number } | null = null
  for (const c of correspondents) {
    const needle = normalizeName(c.name)
    if (needle.length < 3) continue
    if (haystack.includes(` ${needle} `) && (!best || needle.length > best.length)) {
      best = { c, length: needle.length }
    }
  }
  return best?.c ?? null
}

export function buildPrompt(input: {
  content: string
  vocabulary: Vocabulary
  examples: Example[]
}): { system: string; user: string } {
  const tags = selectableTags(input.vocabulary).sort(
    (a, b) => b.documentCount - a.documentCount || a.name.localeCompare(b.name),
  )
  const correspondents = [...input.vocabulary.correspondents].sort((a, b) => a.name.localeCompare(b.name))
  const system = [
    RULES,
    '',
    'Existing correspondents:',
    ...(correspondents.length > 0 ? correspondents.map((c) => `- ${c.name}`) : ['(none)']),
    '',
    'Existing tags (number of documents using the tag):',
    ...(tags.length > 0 ? tags.map((t) => `- ${t.name} (${t.documentCount})`) : ['(none)']),
  ].join('\n')

  const parts: string[] = []
  if (input.examples.length > 0) {
    parts.push('Examples of documents that were already filed:')
    input.examples.forEach((ex, i) => {
      parts.push(
        '',
        `### Example ${i + 1}`,
        'Text:',
        '"""',
        truncateContent(ex.content, EXAMPLE_CHARS),
        '"""',
        `Filed as: ${JSON.stringify({ title: ex.title, created_date: ex.createdDate, correspondent: ex.correspondent, tags: ex.tags })}`,
      )
    })
    parts.push('')
  }
  parts.push('### Document to file', 'Text:', '"""', input.content, '"""')
  return { system, user: parts.join('\n') }
}

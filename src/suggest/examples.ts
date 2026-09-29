import type { PaperlessClient } from '../paperless/client'
import type { PaperlessDocument, Vocabulary } from '../paperless/types'
import { guessCorrespondent } from './prompt'
import type { Example } from './types'

export const EXAMPLE_COUNT = 3
const MAX_FETCH = 100

export function toExample(doc: PaperlessDocument, v: Vocabulary): Example {
  const tagNames = new Map(v.tags.map((t) => [t.id, t.name]))
  const correspondentNames = new Map(v.correspondents.map((c) => [c.id, c.name]))
  return {
    title: doc.title,
    correspondent: doc.correspondent === null ? null : (correspondentNames.get(doc.correspondent) ?? null),
    tags: doc.tags
      .filter((id) => id !== v.inboxTagId)
      .map((id) => tagNames.get(id))
      .filter((n): n is string => n !== undefined),
    content: doc.content,
  }
}

/** Filed documents (not in the inbox) used as few-shot examples; ids in `exclude` are never used. */
export async function loadExamples(
  client: Pick<PaperlessClient, 'listFiledDocuments'>,
  v: Vocabulary,
  content: string,
  exclude: ReadonlySet<number>,
): Promise<Example[]> {
  const limit = Math.min(EXAMPLE_COUNT + exclude.size, MAX_FETCH)
  const guess = guessCorrespondent(content, v.correspondents)
  let docs: PaperlessDocument[] = []
  if (guess) {
    docs = (await client.listFiledDocuments({ inboxTagId: v.inboxTagId, correspondentId: guess.id, limit })).filter(
      (d) => !exclude.has(d.id),
    )
  }
  if (docs.length === 0) {
    docs = (await client.listFiledDocuments({ inboxTagId: v.inboxTagId, limit })).filter((d) => !exclude.has(d.id))
  }
  return docs.slice(0, EXAMPLE_COUNT).map((d) => toExample(d, v))
}

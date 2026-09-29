import { z } from 'zod'
import type { PaperlessClient } from '../paperless/client'
import type { PaperlessDocument, Vocabulary } from '../paperless/types'
import type { SuggestionStore } from '../store/suggestions'

const EntityRefSchema = z.union([
  z.object({ id: z.number().int().positive() }),
  z.object({ name: z.string().trim().min(1).max(128) }),
])

export const ApplyRequestSchema = z.object({
  title: z.string().trim().min(1).max(128),
  correspondent: EntityRefSchema.nullable(),
  tags: z.array(EntityRefSchema).max(50),
  expectedModified: z.string().min(1),
})

export type EntityRef = z.infer<typeof EntityRefSchema>
export type ApplyRequest = z.infer<typeof ApplyRequestSchema>

export type ApplyResult =
  | { kind: 'applied'; document: PaperlessDocument }
  | { kind: 'conflict'; reason: 'modified'; current: PaperlessDocument }
  | { kind: 'conflict'; reason: 'missing'; missingTagIds: number[]; missingCorrespondentId: number | null }

export async function applySuggestion(
  deps: { paperless: PaperlessClient; store: SuggestionStore },
  documentId: number,
  req: ApplyRequest,
  vocab: Vocabulary,
): Promise<ApplyResult> {
  const { paperless, store } = deps
  const current = await paperless.getDocument(documentId)
  if (current.modified !== req.expectedModified) return { kind: 'conflict', reason: 'modified', current }

  const tagIds = new Set(vocab.tags.map((t) => t.id))
  const correspondentIds = new Set(vocab.correspondents.map((c) => c.id))
  const missingTagIds = req.tags.flatMap((r) => ('id' in r && !tagIds.has(r.id) ? [r.id] : []))
  const missingCorrespondentId =
    req.correspondent && 'id' in req.correspondent && !correspondentIds.has(req.correspondent.id)
      ? req.correspondent.id
      : null
  if (missingTagIds.length > 0 || missingCorrespondentId !== null) {
    return { kind: 'conflict', reason: 'missing', missingTagIds, missingCorrespondentId }
  }

  const createdTags = new Map<string, number>()
  async function tagId(ref: EntityRef): Promise<number> {
    if ('id' in ref) return ref.id
    const key = ref.name.toLowerCase()
    const existing = vocab.tags.find((t) => t.name.toLowerCase() === key)?.id ?? createdTags.get(key)
    if (existing !== undefined) return existing
    const created = await paperless.createTag(ref.name)
    createdTags.set(key, created.id)
    return created.id
  }
  async function correspondentId(ref: EntityRef): Promise<number> {
    if ('id' in ref) return ref.id
    const existing = vocab.correspondents.find((c) => c.name.toLowerCase() === ref.name.toLowerCase())
    return existing ? existing.id : (await paperless.createCorrespondent(ref.name)).id
  }

  const correspondent = req.correspondent === null ? null : await correspondentId(req.correspondent)
  const tags: number[] = []
  for (const ref of req.tags) {
    const id = await tagId(ref)
    if (id !== vocab.inboxTagId && !tags.includes(id)) tags.push(id)
  }

  const document = await paperless.updateDocument(documentId, { title: req.title, correspondent, tags })
  store.markApplied(documentId)
  return { kind: 'applied', document }
}

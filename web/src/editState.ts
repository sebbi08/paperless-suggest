import type { ApplyRequestBody, DocumentDetail, NamedRef, NearMatch } from '../../src/api/types'
import { rankMatches } from '../../src/suggest/normalize'

export type EntityEntry =
  | { kind: 'existing'; id: number; matchedFrom?: string }
  | { kind: 'new'; name: string; nearest: NearMatch[] }
export type TagEntry = EntityEntry
export type CorrespondentEntry = EntityEntry | null

export interface EditState {
  title: string
  correspondent: CorrespondentEntry
  tags: TagEntry[]
}

const hasExisting = (tags: TagEntry[], id: number) => tags.some((t) => t.kind === 'existing' && t.id === id)

export function initialEditState(detail: DocumentDetail): EditState {
  const { document: doc, suggestion: s, vocabulary: v } = detail
  const currentTags: TagEntry[] = doc.tagIds.filter((id) => id !== v.inboxTagId).map((id) => ({ kind: 'existing', id }))
  const currentCorrespondent: CorrespondentEntry =
    doc.correspondentId === null ? null : { kind: 'existing', id: doc.correspondentId }

  if (!s || s.status !== 'ready') {
    return { title: doc.title, correspondent: currentCorrespondent, tags: currentTags }
  }

  const existing = (id: number, list: NamedRef[]): EntityEntry => {
    const name = list.find((e) => e.id === id)?.name
    const from = Object.entries(s.matchedNotes).find(([, to]) => to === name)?.[0]
    return from === undefined ? { kind: 'existing', id } : { kind: 'existing', id, matchedFrom: from }
  }

  const correspondent: CorrespondentEntry =
    s.correspondentId !== null
      ? existing(s.correspondentId, v.correspondents)
      : s.proposedCorrespondent
        ? { kind: 'new', name: s.proposedCorrespondent.name, nearest: s.proposedCorrespondent.nearest }
        : currentCorrespondent

  const tags = [...currentTags]
  for (const id of s.tagIds) if (!hasExisting(tags, id)) tags.push(existing(id, v.tags))
  for (const p of s.proposedTags) tags.push({ kind: 'new', name: p.name, nearest: p.nearest })

  return { title: s.title ?? doc.title, correspondent, tags }
}

export function removeTagAt(tags: TagEntry[], index: number): TagEntry[] {
  return tags.filter((_, i) => i !== index)
}

export function addExistingTag(tags: TagEntry[], id: number): TagEntry[] {
  return hasExisting(tags, id) ? tags : [...tags, { kind: 'existing', id }]
}

export function addNewTag(tags: TagEntry[], name: string, options: NamedRef[]): TagEntry[] {
  const trimmed = name.trim()
  if (!trimmed) return tags
  const key = trimmed.toLowerCase()
  const match = options.find((o) => o.name.toLowerCase() === key)
  if (match) return addExistingTag(tags, match.id)
  if (tags.some((t) => t.kind === 'new' && t.name.toLowerCase() === key)) return tags
  return [...tags, { kind: 'new', name: trimmed, nearest: rankMatches(trimmed, options) }]
}

export function replaceNewTag(tags: TagEntry[], index: number, id: number): TagEntry[] {
  const without = removeTagAt(tags, index)
  if (hasExisting(without, id)) return without
  return [...without.slice(0, index), { kind: 'existing', id }, ...without.slice(index)]
}

export function canApply(state: EditState): boolean {
  return state.title.trim().length > 0 && (state.correspondent?.kind !== 'new' || state.correspondent.name.trim().length > 0)
}

export function toApplyRequest(state: EditState, expectedModified: string): ApplyRequestBody {
  const ref = (e: EntityEntry) => (e.kind === 'existing' ? { id: e.id } : { name: e.name.trim() })
  return {
    title: state.title.trim(),
    correspondent: state.correspondent === null ? null : ref(state.correspondent),
    tags: state.tags.map(ref),
    expectedModified,
  }
}

export function applyMissing(
  state: EditState,
  missing: { missingTagIds: number[]; missingCorrespondentId: number | null },
  vocabulary: DocumentDetail['vocabulary'],
): EditState {
  const toNew = (id: number, list: NamedRef[]): EntityEntry => {
    const name = list.find((e) => e.id === id)?.name ?? `#${id}`
    return { kind: 'new', name, nearest: rankMatches(name, list.filter((e) => e.id !== id)) }
  }
  const c = state.correspondent
  return {
    ...state,
    correspondent:
      c?.kind === 'existing' && c.id === missing.missingCorrespondentId ? toNew(c.id, vocabulary.correspondents) : c,
    tags: state.tags.map((t) =>
      t.kind === 'existing' && missing.missingTagIds.includes(t.id) ? toNew(t.id, vocabulary.tags) : t,
    ),
  }
}

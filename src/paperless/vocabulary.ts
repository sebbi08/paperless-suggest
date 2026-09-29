import { createHash } from 'node:crypto'
import type { PaperlessClient } from './client'
import type { PaperlessTag, Vocabulary } from './types'

export class InboxTagError extends Error {
  override name = 'InboxTagError'
}

export function resolveInboxTag(tags: PaperlessTag[], inboxTag: string | null): PaperlessTag {
  if (inboxTag !== null) {
    const byId = /^\d+$/.test(inboxTag) ? tags.find((t) => t.id === Number(inboxTag)) : undefined
    const found = byId ?? tags.find((t) => t.name.toLowerCase() === inboxTag.toLowerCase())
    if (!found) throw new InboxTagError(`INBOX_TAG "${inboxTag}" does not match any Paperless tag`)
    return found
  }
  const flagged = tags.find((t) => t.isInboxTag)
  if (!flagged) throw new InboxTagError('No Paperless tag is marked as inbox tag; set INBOX_TAG')
  return flagged
}

export async function loadVocabulary(
  client: Pick<PaperlessClient, 'listTags' | 'listCorrespondents'>,
  inboxTag: string | null,
): Promise<Vocabulary> {
  const [tags, correspondents] = await Promise.all([client.listTags(), client.listCorrespondents()])
  return { inboxTagId: resolveInboxTag(tags, inboxTag).id, tags, correspondents }
}

export function selectableTags(v: Vocabulary): PaperlessTag[] {
  return v.tags.filter((t) => t.id !== v.inboxTagId)
}

/** Hash of ids and names only; document counts change on every apply and must not invalidate suggestions. */
export function hashVocabulary(v: Vocabulary): string {
  const parts = [
    `inbox:${v.inboxTagId}`,
    ...[...v.tags].sort((a, b) => a.id - b.id).map((t) => `t${t.id}:${t.name}`),
    ...[...v.correspondents].sort((a, b) => a.id - b.id).map((c) => `c${c.id}:${c.name}`),
  ]
  return createHash('sha256').update(parts.join('\n')).digest('hex')
}

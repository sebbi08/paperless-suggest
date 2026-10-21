import type { Proposal, SuggestResult } from '../suggest/types'
import type { Db } from './db'

export type SuggestionStatus = 'pending' | 'ready' | 'applied' | 'error' | 'no_text'

export interface StoredSuggestion {
  documentId: number
  status: SuggestionStatus
  title: string | null
  createdDate: string | null
  correspondentId: number | null
  proposedCorrespondent: Proposal | null
  tagIds: number[]
  proposedTags: Proposal[]
  matchedNotes: Record<string, string>
  model: string | null
  error: string | null
  docModified: string | null
  /** Changes only when the suggestion or its status changes. */
  updatedAt: string
}

export interface InboxItem {
  documentId: number
  added: string
  contentHash: string
}

export interface ResultMeta {
  contentHash: string
  vocabHash: string
  docModified: string
}

export interface StatusCounts {
  ready: number
  pending: number
  error: number
  noText: number
}

interface Row {
  document_id: number
  status: SuggestionStatus
  added: string
  title: string | null
  created_date: string | null
  correspondent_id: number | null
  proposed_correspondent: string | null
  tag_ids: string
  proposed_tags: string
  matched_notes: string
  model: string | null
  content_hash: string | null
  vocab_hash: string | null
  doc_modified: string | null
  error: string | null
  updated_at: string
}

const REVIEWABLE = `in_inbox = 1 AND status IN ('ready', 'error', 'no_text')`

export class SuggestionStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private ts(): string {
    return this.now().toISOString()
  }

  syncInbox(items: InboxItem[], vocabHash: string): void {
    const find = this.db.prepare('SELECT status, content_hash, vocab_hash FROM suggestions WHERE document_id = ?')
    const insert = this.db.prepare(
      `INSERT INTO suggestions (document_id, status, in_inbox, added, created_at, updated_at)
       VALUES (@id, 'pending', 1, @added, @now, @now)`,
    )
    const keep = this.db.prepare('UPDATE suggestions SET in_inbox = 1, added = @added WHERE document_id = @id')
    const markStale = this.db.prepare('UPDATE suggestions SET in_inbox = 1, added = @added, stale = 1 WHERE document_id = @id')
    const reset = this.db.prepare(
      `UPDATE suggestions SET in_inbox = 1, added = @added, status = 'pending', stale = 0, updated_at = @now WHERE document_id = @id`,
    )
    this.db.transaction(() => {
      this.db.prepare('UPDATE suggestions SET in_inbox = 0').run()
      const now = this.ts()
      for (const it of items) {
        const row = find.get(it.documentId) as Pick<Row, 'status' | 'content_hash' | 'vocab_hash'> | undefined
        const params = { id: it.documentId, added: it.added }
        if (!row) {
          insert.run({ ...params, now })
          continue
        }
        const changed = row.content_hash !== it.contentHash || row.vocab_hash !== vocabHash
        if (row.status === 'applied' || (row.status === 'no_text' && changed)) reset.run({ ...params, now })
        else if ((row.status === 'ready' || row.status === 'error') && changed) markStale.run(params)
        else keep.run(params)
      }
    })()
  }

  isStale(documentId: number): boolean {
    const r = this.db.prepare('SELECT stale FROM suggestions WHERE document_id = ?').get(documentId) as
      | { stale: number }
      | undefined
    return r?.stale === 1
  }

  /** Next document to suggest for; ids in `busy` are being worked on and skipped. */
  nextWork(busy: ReadonlySet<number> = new Set()): number | null {
    const row = this.db
      .prepare(
        `SELECT document_id FROM suggestions WHERE in_inbox = 1 AND (status = 'pending' OR stale = 1)
         AND document_id NOT IN (SELECT value FROM json_each(?))
         ORDER BY priority DESC, added ASC, document_id ASC LIMIT 1`,
      )
      .get(JSON.stringify([...busy])) as { document_id: number } | undefined
    return row?.document_id ?? null
  }

  saveResult(documentId: number, result: SuggestResult, meta: ResultMeta): void {
    const s = result.kind === 'ok' ? result.suggestion : null
    this.db
      .prepare(
        `UPDATE suggestions SET
           status = @status, title = @title, created_date = @createdDate, correspondent_id = @correspondentId,
           proposed_correspondent = @proposedCorrespondent, tag_ids = @tagIds, proposed_tags = @proposedTags,
           matched_notes = @matchedNotes, model = @model, error = @error,
           content_hash = @contentHash, vocab_hash = @vocabHash, doc_modified = @docModified,
           attempts = attempts + 1, priority = 0, stale = 0, updated_at = @now
         WHERE document_id = @documentId AND (status = 'pending' OR stale = 1)`,
      )
      .run({
        documentId,
        status: result.kind === 'ok' ? 'ready' : result.kind,
        title: s?.title ?? null,
        createdDate: s?.createdDate ?? null,
        correspondentId: s?.correspondentId ?? null,
        proposedCorrespondent: s?.proposedCorrespondent ? JSON.stringify(s.proposedCorrespondent) : null,
        tagIds: JSON.stringify(s?.tagIds ?? []),
        proposedTags: JSON.stringify(s?.proposedTags ?? []),
        matchedNotes: JSON.stringify(s?.matchedNotes ?? {}),
        model: s?.model ?? (result.kind === 'error' ? result.model : null),
        error: result.kind === 'error' ? result.error : null,
        contentHash: meta.contentHash,
        vocabHash: meta.vocabHash,
        docModified: meta.docModified,
        now: this.ts(),
      })
  }

  get(documentId: number): StoredSuggestion | null {
    const r = this.db.prepare('SELECT * FROM suggestions WHERE document_id = ?').get(documentId) as Row | undefined
    if (!r) return null
    return {
      documentId: r.document_id,
      status: r.status,
      title: r.title,
      createdDate: r.created_date,
      correspondentId: r.correspondent_id,
      proposedCorrespondent: r.proposed_correspondent ? (JSON.parse(r.proposed_correspondent) as Proposal) : null,
      tagIds: JSON.parse(r.tag_ids) as number[],
      proposedTags: JSON.parse(r.proposed_tags) as Proposal[],
      matchedNotes: JSON.parse(r.matched_notes) as Record<string, string>,
      model: r.model,
      error: r.error,
      docModified: r.doc_modified,
      updatedAt: r.updated_at,
    }
  }

  nextReviewable(afterId?: number): number | null {
    const ref =
      afterId === undefined
        ? undefined
        : (this.db.prepare('SELECT added FROM suggestions WHERE document_id = ?').get(afterId) as
            | { added: string }
            | undefined)
    const row = (
      ref
        ? this.db
            .prepare(
              `SELECT document_id FROM suggestions WHERE ${REVIEWABLE}
               AND (added > @added OR (added = @added AND document_id > @id))
               ORDER BY added, document_id LIMIT 1`,
            )
            .get({ added: ref.added, id: afterId })
        : this.db.prepare(`SELECT document_id FROM suggestions WHERE ${REVIEWABLE} ORDER BY added, document_id LIMIT 1`).get()
    ) as { document_id: number } | undefined
    return row?.document_id ?? null
  }

  requestRegenerate(documentId: number): boolean {
    const r = this.db
      .prepare(
        `UPDATE suggestions SET status = 'pending', priority = 1, updated_at = ?
         WHERE document_id = ? AND in_inbox = 1 AND status != 'applied'`,
      )
      .run(this.ts(), documentId)
    return r.changes > 0
  }

  markApplied(documentId: number): void {
    this.db
      .prepare(`UPDATE suggestions SET status = 'applied', priority = 0, stale = 0, updated_at = ? WHERE document_id = ?`)
      .run(this.ts(), documentId)
  }

  counts(): StatusCounts {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS n FROM suggestions WHERE in_inbox = 1 GROUP BY status')
      .all() as { status: SuggestionStatus; n: number }[]
    const by = Object.fromEntries(rows.map((r) => [r.status, r.n])) as Partial<Record<SuggestionStatus, number>>
    return { ready: by.ready ?? 0, pending: by.pending ?? 0, error: by.error ?? 0, noText: by.no_text ?? 0 }
  }

  getMeta(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
    return r?.value ?? null
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value)
  }
}

import { describe, expect, it, vi } from 'vitest'
import { applySuggestion, ApplyRequestSchema, type ApplyRequest } from '../../src/apply/apply'
import type { DocumentPatch, PaperlessDocument } from '../../src/paperless/types'
import { openDb } from '../../src/store/db'
import { SuggestionStore } from '../../src/store/suggestions'
import { fakePaperless } from '../helpers/fakes'
import { makeDocument, makeVocabulary } from '../helpers/fixtures'

const ORIGINAL_MODIFIED = '2026-09-14T10:00:05+02:00'

function setup() {
  const store = new SuggestionStore(openDb(':memory:'))
  store.syncInbox([{ documentId: 100, added: 'a', contentHash: 'c' }], 'v')
  let current: PaperlessDocument = makeDocument({ id: 100, tags: [1, 3], modified: ORIGINAL_MODIFIED })
  let nextTagId = 50
  const paperless = fakePaperless({
    getDocument: vi.fn(async () => current),
    createTag: vi.fn(async (name: string) => ({ id: nextTagId++, name, isInboxTag: false, documentCount: 0 })),
    createCorrespondent: vi.fn(async (name: string) => ({ id: 70, name, documentCount: 0 })),
    updateDocument: vi.fn(async (_id: number, patch: DocumentPatch) => {
      current = { ...current, ...patch, modified: '2026-09-14T11:00:00+02:00' } as PaperlessDocument
      return current
    }),
  })
  const apply = (req: ApplyRequest) => applySuggestion({ paperless, store }, 100, req, makeVocabulary())
  return { store, paperless, apply }
}

const req = (o: Partial<ApplyRequest> = {}): ApplyRequest => ({
  title: 'Telekom Rechnung',
  correspondent: { id: 10 },
  tags: [{ id: 2 }, { id: 3 }],
  expectedModified: ORIGINAL_MODIFIED,
  ...o,
})

describe('applySuggestion', () => {
  it('writes title, correspondent and tags without the inbox tag and marks applied', async () => {
    const { store, paperless, apply } = setup()
    const r = await apply(req({ tags: [{ id: 1 }, { id: 2 }, { id: 3 }] }))
    expect(r.kind).toBe('applied')
    expect(paperless.updateDocument).toHaveBeenCalledWith(100, { title: 'Telekom Rechnung', correspondent: 10, tags: [2, 3] })
    expect(store.get(100)?.status).toBe('applied')
  })

  it('writes the issue date when one is given', async () => {
    const { paperless, apply } = setup()
    await apply(req({ created: '2026-09-12' }))
    expect(paperless.updateDocument).toHaveBeenCalledWith(100, {
      title: 'Telekom Rechnung',
      created: '2026-09-12',
      correspondent: 10,
      tags: [2, 3],
    })
  })

  it('creates new tags and correspondents the user kept', async () => {
    const { paperless, apply } = setup()
    await apply(req({ correspondent: { name: 'Neue Firma' }, tags: [{ id: 2 }, { name: 'Mobilfunk' }] }))
    expect(paperless.createCorrespondent).toHaveBeenCalledWith('Neue Firma')
    expect(paperless.createTag).toHaveBeenCalledWith('Mobilfunk')
    expect(paperless.updateDocument).toHaveBeenCalledWith(100, { title: 'Telekom Rechnung', correspondent: 70, tags: [2, 50] })
  })

  it('reuses existing names case-insensitively instead of creating duplicates', async () => {
    const { paperless, apply } = setup()
    await apply(req({ correspondent: { name: 'deutsche telekom ag' }, tags: [{ name: 'rechnung' }] }))
    expect(paperless.createTag).not.toHaveBeenCalled()
    expect(paperless.createCorrespondent).not.toHaveBeenCalled()
    expect(paperless.updateDocument).toHaveBeenCalledWith(100, { title: 'Telekom Rechnung', correspondent: 10, tags: [2] })
  })

  it('creates a new name only once even if listed twice', async () => {
    const { paperless, apply } = setup()
    await apply(req({ tags: [{ name: 'Neu' }, { name: 'neu' }] }))
    expect(paperless.createTag).toHaveBeenCalledTimes(1)
    expect(paperless.updateDocument).toHaveBeenCalledWith(100, expect.objectContaining({ tags: [50] }))
  })

  it('allows clearing the correspondent', async () => {
    const { paperless, apply } = setup()
    await apply(req({ correspondent: null }))
    expect(paperless.updateDocument).toHaveBeenCalledWith(100, expect.objectContaining({ correspondent: null }))
  })

  it('refuses to overwrite a document modified since it was loaded', async () => {
    const { paperless, apply } = setup()
    const r = await apply(req({ expectedModified: 'older' }))
    expect(r).toMatchObject({ kind: 'conflict', reason: 'modified', current: { id: 100 } })
    expect(paperless.updateDocument).not.toHaveBeenCalled()
  })

  it('reports deleted tags and correspondents without writing anything', async () => {
    const { paperless, apply } = setup()
    const r = await apply(req({ correspondent: { id: 98 }, tags: [{ id: 2 }, { id: 99 }, { name: 'Neu' }] }))
    expect(r).toEqual({ kind: 'conflict', reason: 'missing', missingTagIds: [99], missingCorrespondentId: 98 })
    expect(paperless.createTag).not.toHaveBeenCalled()
    expect(paperless.updateDocument).not.toHaveBeenCalled()
  })

  it('rejects a second apply from another device with the stale timestamp', async () => {
    const { paperless, apply } = setup()
    expect((await apply(req())).kind).toBe('applied')
    const second = await apply(req())
    expect(second).toMatchObject({ kind: 'conflict', reason: 'modified' })
    expect(paperless.updateDocument).toHaveBeenCalledTimes(1)
  })
})

describe('ApplyRequestSchema', () => {
  it('accepts ids and names and trims the title', () => {
    const r = ApplyRequestSchema.parse({ title: ' T ', correspondent: { name: 'X' }, tags: [{ id: 1 }, { name: 'Y' }], expectedModified: 'm' })
    expect(r.title).toBe('T')
  })

  it('accepts only real dates as issue date', () => {
    const base = { title: 'T', correspondent: null, tags: [], expectedModified: 'm' }
    expect(ApplyRequestSchema.parse({ ...base, created: '2026-09-12' }).created).toBe('2026-09-12')
    expect(ApplyRequestSchema.safeParse({ ...base, created: '2026-02-30' }).success).toBe(false)
    expect(ApplyRequestSchema.safeParse({ ...base, created: '12.09.2026' }).success).toBe(false)
  })

  it('rejects blank or too long titles and empty names', () => {
    const base = { correspondent: null, tags: [], expectedModified: 'm' }
    expect(ApplyRequestSchema.safeParse({ ...base, title: '  ' }).success).toBe(false)
    expect(ApplyRequestSchema.safeParse({ ...base, title: 'x'.repeat(129) }).success).toBe(false)
    expect(ApplyRequestSchema.safeParse({ ...base, title: 'x', tags: [{ name: ' ' }] }).success).toBe(false)
  })
})

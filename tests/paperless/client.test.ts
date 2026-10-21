import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { createPaperlessClient, PaperlessError } from '../../src/paperless/client'
import { useMswServer } from '../helpers/msw'

const BASE = 'http://paperless.test'
const server = useMswServer()
const client = () => createPaperlessClient({ baseUrl: `${BASE}/`, token: 'secret' })

const rawDoc = (id: number) => ({
  id,
  title: `doc ${id}`,
  content: null,
  correspondent: null,
  tags: [1],
  created: '2026-09-01T00:00:00Z',
  added: '2026-09-01T00:00:00Z',
  modified: '2026-09-01T00:00:00Z',
})

describe('PaperlessClient', () => {
  it('lists inbox documents across pages with token auth', async () => {
    const seen: string[] = []
    server.use(
      http.get(`${BASE}/api/documents/`, ({ request }) => {
        const url = new URL(request.url)
        seen.push(request.headers.get('authorization') ?? '')
        expect(url.searchParams.get('tags__id__all')).toBe('1')
        expect(url.searchParams.get('ordering')).toBe('added')
        const page = url.searchParams.get('page')
        return HttpResponse.json(
          page === '1'
            ? { count: 2, next: `${BASE}/api/documents/?page=2`, results: [rawDoc(1)] }
            : { count: 2, next: null, results: [rawDoc(2)] },
        )
      }),
    )
    const docs = await client().listInboxDocuments(1)
    expect(docs.map((d) => d.id)).toEqual([1, 2])
    expect(docs[0]!.content).toBe('')
    expect(docs[0]!.created).toBe('2026-09-01')
    expect(seen).toEqual(['Token secret', 'Token secret'])
  })

  it('maps tags and correspondents', async () => {
    server.use(
      http.get(`${BASE}/api/tags/`, () =>
        HttpResponse.json({ count: 1, next: null, results: [{ id: 1, name: 'Inbox', is_inbox_tag: true, document_count: 3 }] }),
      ),
      http.get(`${BASE}/api/correspondents/`, () =>
        HttpResponse.json({ count: 1, next: null, results: [{ id: 9, name: 'ACME', document_count: 2 }] }),
      ),
    )
    expect(await client().listTags()).toEqual([{ id: 1, name: 'Inbox', isInboxTag: true, documentCount: 3 }])
    expect(await client().listCorrespondents()).toEqual([{ id: 9, name: 'ACME', documentCount: 2 }])
  })

  it('lists filed documents for a correspondent or any correspondent', async () => {
    const queries: Record<string, string>[] = []
    server.use(
      http.get(`${BASE}/api/documents/`, ({ request }) => {
        queries.push(Object.fromEntries(new URL(request.url).searchParams))
        return HttpResponse.json({ count: 1, next: `${BASE}/next`, results: [rawDoc(5)] })
      }),
    )
    await client().listFiledDocuments({ inboxTagId: 1, correspondentId: 7, limit: 3 })
    await client().listFiledDocuments({ inboxTagId: 1, limit: 3 })
    expect(queries[0]).toMatchObject({ tags__id__none: '1', correspondent__id: '7', page_size: '3', ordering: '-added' })
    expect(queries[1]).toMatchObject({ tags__id__none: '1', correspondent__isnull: 'false', page_size: '3' })
    expect(queries[1]).not.toHaveProperty('correspondent__id')
  })

  it('creates tags with matching disabled and patches documents', async () => {
    let tagBody: unknown
    let patchBody: unknown
    server.use(
      http.post(`${BASE}/api/tags/`, async ({ request }) => {
        tagBody = await request.json()
        return HttpResponse.json({ id: 7, name: 'Mobilfunk', is_inbox_tag: false, document_count: 0 })
      }),
      http.patch(`${BASE}/api/documents/5/`, async ({ request }) => {
        patchBody = await request.json()
        return HttpResponse.json(rawDoc(5))
      }),
    )
    expect(await client().createTag('Mobilfunk')).toEqual({ id: 7, name: 'Mobilfunk', isInboxTag: false, documentCount: 0 })
    expect(tagBody).toEqual({ name: 'Mobilfunk', matching_algorithm: 0 })
    await client().updateDocument(5, { title: 'T', correspondent: null, tags: [2], created: '2026-08-31' })
    expect(patchBody).toEqual({ title: 'T', correspondent: null, tags: [2], created: '2026-08-31' })
  })

  it('returns the raw response for files', async () => {
    server.use(
      http.get(`${BASE}/api/documents/5/thumb/`, () =>
        new HttpResponse('img', { headers: { 'content-type': 'image/webp' } }),
      ),
    )
    const res = await client().fetchFile(5, 'thumb')
    expect(res.headers.get('content-type')).toBe('image/webp')
    expect(await res.text()).toBe('img')
  })

  it('throws PaperlessError with status on HTTP errors', async () => {
    server.use(http.get(`${BASE}/api/documents/9/`, () => HttpResponse.json({ detail: 'Not found.' }, { status: 404 })))
    const err = await client().getDocument(9).catch((e) => e)
    expect(err).toBeInstanceOf(PaperlessError)
    expect(err.status).toBe(404)
    expect(err.message).toContain('404')
  })

  it('throws PaperlessError without status on network errors', async () => {
    server.use(http.get(`${BASE}/api/tags/`, () => HttpResponse.error()))
    const err = await client().listTags().catch((e) => e)
    expect(err).toBeInstanceOf(PaperlessError)
    expect(err.status).toBeNull()
  })
})

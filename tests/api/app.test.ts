import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/api/app'
import { createAuth } from '../../src/api/auth'
import type { DocumentDetail, StatusResponse } from '../../src/api/types'
import { PaperlessError } from '../../src/paperless/client'
import type { DocumentPatch, PaperlessDocument } from '../../src/paperless/types'
import { openDb } from '../../src/store/db'
import { SuggestionStore } from '../../src/store/suggestions'
import { fakePaperless } from '../helpers/fakes'
import { makeDocument, makeVocabulary } from '../helpers/fixtures'

function setup(opts: { authDisabled?: boolean; staticDir?: string | null } = {}) {
  const store = new SuggestionStore(openDb(':memory:'))
  const v = makeVocabulary()
  const doc = makeDocument({ id: 100 })
  const paperless = fakePaperless({
    listTags: async () => v.tags,
    listCorrespondents: async () => v.correspondents,
    getDocument: vi.fn(async () => doc),
    updateDocument: vi.fn(async (_id: number, patch: DocumentPatch) => ({ ...doc, ...patch }) as PaperlessDocument),
    fetchFile: vi.fn(async () => new Response('IMG', { headers: { 'content-type': 'image/webp' } })),
  })
  const worker = {
    status: () => ({ paperless: { ok: true, error: null }, llm: { ok: true, model: 'qwen3-14b', error: null }, lastPollAt: 'x' }),
    wake: vi.fn(),
  }
  const auth = createAuth({ password: 'pw', disabled: opts.authDisabled ?? true, secret: 's' })
  store.syncInbox([{ documentId: 100, added: 'a', contentHash: 'c' }], 'v')
  store.saveResult(
    100,
    { kind: 'ok', suggestion: { title: 'T', correspondentId: 10, proposedCorrespondent: null, tagIds: [2], proposedTags: [], matchedNotes: {}, model: 'm' } },
    { contentHash: 'c', vocabHash: 'v', docModified: doc.modified },
  )
  const app = createApp({ paperless, store, worker, auth, inboxTag: null, staticDir: opts.staticDir ?? null })
  return { app, store, paperless, worker, doc }
}

const post = (app: ReturnType<typeof setup>['app'], url: string, body?: unknown) =>
  app.request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

describe('API', () => {
  it('requires a session for everything except login', async () => {
    const { app } = setup({ authDisabled: false })
    expect((await app.request('/api/status')).status).toBe(401)
    expect((await post(app, '/api/login', { password: 'pw' })).status).toBe(200)
  })

  it('reports status with counts', async () => {
    const { app } = setup()
    const body = (await (await app.request('/api/status')).json()) as StatusResponse
    expect(body.llm.model).toBe('qwen3-14b')
    expect(body.counts).toEqual({ ready: 1, pending: 0, error: 0, noText: 0 })
  })

  it('returns the next reviewable document', async () => {
    const { app } = setup()
    expect(await (await app.request('/api/queue/next')).json()).toEqual({ documentId: 100 })
    expect(await (await app.request('/api/queue/next?after=100')).json()).toEqual({ documentId: null })
    expect((await app.request('/api/queue/next?after=abc')).status).toBe(400)
  })

  it('returns document detail with suggestion and vocabulary without the inbox tag', async () => {
    const { app } = setup()
    const body = (await (await app.request('/api/documents/100')).json()) as DocumentDetail
    expect(body.document).toMatchObject({ id: 100, title: 'scan_0001', tagIds: [1] })
    expect(body.document.content).toContain('Telekom')
    expect(body.suggestion?.status).toBe('ready')
    expect(body.vocabulary.inboxTagId).toBe(1)
    expect(body.vocabulary.tags.map((t) => t.id)).toEqual([2, 3, 4, 5])
    expect(body.vocabulary.correspondents[0]).toEqual({ id: 10, name: 'Deutsche Telekom AG' })
  })

  it('rejects invalid ids', async () => {
    const { app } = setup()
    expect((await app.request('/api/documents/abc')).status).toBe(400)
  })

  it('proxies thumbnails', async () => {
    const { app, paperless } = setup()
    const res = await app.request('/api/documents/100/thumb')
    expect(res.headers.get('content-type')).toBe('image/webp')
    expect(await res.text()).toBe('IMG')
    expect(paperless.fetchFile).toHaveBeenCalledWith(100, 'thumb')
  })

  it('applies a confirmed suggestion', async () => {
    const { app, store, paperless, doc } = setup()
    const res = await post(app, '/api/documents/100/apply', {
      title: 'Telekom Rechnung',
      correspondent: { id: 10 },
      tags: [{ id: 2 }],
      expectedModified: doc.modified,
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'applied' })
    expect(paperless.updateDocument).toHaveBeenCalledWith(100, { title: 'Telekom Rechnung', correspondent: 10, tags: [2] })
    expect(store.get(100)?.status).toBe('applied')
  })

  it('rejects an invalid apply body', async () => {
    const { app } = setup()
    const res = await post(app, '/api/documents/100/apply', { title: '', correspondent: null, tags: [], expectedModified: 'm' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('title')
  })

  it('returns 409 on conflicts', async () => {
    const { app } = setup()
    const res = await post(app, '/api/documents/100/apply', { title: 'T', correspondent: null, tags: [], expectedModified: 'old' })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ reason: 'modified', current: { id: 100 } })
  })

  it('queues regeneration and wakes the worker', async () => {
    const { app, store, worker } = setup()
    const res = await post(app, '/api/documents/100/regenerate')
    expect(await res.json()).toEqual({ status: 'pending' })
    expect(store.get(100)?.status).toBe('pending')
    expect(worker.wake).toHaveBeenCalled()
    expect((await post(app, '/api/documents/555/regenerate')).status).toBe(404)
  })

  it('maps Paperless failures to 502', async () => {
    const { app, paperless } = setup()
    vi.mocked(paperless.getDocument).mockRejectedValueOnce(new PaperlessError('Paperless GET failed: 500 boom', 500))
    const res = await app.request('/api/documents/100')
    expect(res.status).toBe(502)
    expect(((await res.json()) as { error: string }).error).toContain('boom')
  })

  it('returns JSON 404 for unknown API routes', async () => {
    const { app } = setup()
    const res = await app.request('/api/nope')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not found' })
  })

  it('serves the SPA with index fallback and without path traversal', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'spa-'))
    mkdirSync(path.join(dir, 'assets'))
    writeFileSync(path.join(dir, 'index.html'), '<html>INDEX</html>')
    writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log(1)')
    const { app } = setup({ staticDir: dir })

    const index = await app.request('/')
    expect(index.headers.get('content-type')).toContain('text/html')
    expect(await index.text()).toContain('INDEX')

    const asset = await app.request('/assets/app.js')
    expect(asset.headers.get('content-type')).toContain('javascript')
    expect(asset.headers.get('cache-control')).toContain('immutable')

    expect(await (await app.request('/review/123')).text()).toContain('INDEX')
    expect(await (await app.request('/assets/..%2F..%2F..%2Fetc%2Fpasswd')).text()).toContain('INDEX')
    expect((await app.request('/api/nope')).status).toBe(404)
  })
})

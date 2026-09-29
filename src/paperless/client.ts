import type {
  DocumentPatch,
  PaperlessCorrespondent,
  PaperlessDocument,
  PaperlessTag,
} from './types'

export class PaperlessError extends Error {
  override name = 'PaperlessError'
  constructor(message: string, readonly status: number | null) {
    super(message)
  }
}

export interface PaperlessClient {
  listInboxDocuments(inboxTagId: number): Promise<PaperlessDocument[]>
  getDocument(id: number): Promise<PaperlessDocument>
  listTags(): Promise<PaperlessTag[]>
  listCorrespondents(): Promise<PaperlessCorrespondent[]>
  listFiledDocuments(opts: { inboxTagId: number; correspondentId?: number; limit: number }): Promise<PaperlessDocument[]>
  createTag(name: string): Promise<PaperlessTag>
  createCorrespondent(name: string): Promise<PaperlessCorrespondent>
  updateDocument(id: number, patch: DocumentPatch): Promise<PaperlessDocument>
  fetchFile(id: number, kind: 'thumb' | 'preview'): Promise<Response>
}

interface RawDocument {
  id: number
  title: string
  content: string | null
  correspondent: number | null
  tags: number[]
  created: string
  added: string
  modified: string
}
interface RawTag { id: number; name: string; is_inbox_tag: boolean; document_count?: number }
interface RawCorrespondent { id: number; name: string; document_count?: number }
interface Page<T> { count: number; next: string | null; results: T[] }

const PAGE_SIZE = 100
const TIMEOUT_MS = 30_000

const toDocument = (r: RawDocument): PaperlessDocument => ({
  id: r.id,
  title: r.title,
  content: r.content ?? '',
  correspondent: r.correspondent,
  tags: r.tags,
  created: r.created,
  added: r.added,
  modified: r.modified,
})
const toTag = (r: RawTag): PaperlessTag => ({
  id: r.id,
  name: r.name,
  isInboxTag: r.is_inbox_tag,
  documentCount: r.document_count ?? 0,
})
const toCorrespondent = (r: RawCorrespondent): PaperlessCorrespondent => ({
  id: r.id,
  name: r.name,
  documentCount: r.document_count ?? 0,
})

export function createPaperlessClient(opts: { baseUrl: string; token: string }): PaperlessClient {
  const baseUrl = opts.baseUrl.replace(/\/+$/, '')

  async function send(method: string, path: string, body?: unknown, accept = 'application/json'): Promise<Response> {
    let res: Response
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Token ${opts.token}`,
          Accept: accept,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (e) {
      throw new PaperlessError(`Paperless ${method} ${path} failed: ${(e as Error).message}`, null)
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new PaperlessError(`Paperless ${method} ${path} failed: ${res.status} ${text.slice(0, 200)}`, res.status)
    }
    return res
  }

  async function json<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await (await send(method, path, body)).json()) as T
  }

  async function getAll<T>(path: string, params: Record<string, string> = {}): Promise<T[]> {
    const out: T[] = []
    for (let page = 1; ; page++) {
      const qs = new URLSearchParams({ ...params, page: String(page), page_size: String(PAGE_SIZE) })
      const data = await json<Page<T>>('GET', `${path}?${qs}`)
      out.push(...data.results)
      if (!data.next) return out
    }
  }

  return {
    async listInboxDocuments(inboxTagId) {
      const raw = await getAll<RawDocument>('/api/documents/', { tags__id__all: String(inboxTagId), ordering: 'added' })
      return raw.map(toDocument)
    },
    async getDocument(id) {
      return toDocument(await json<RawDocument>('GET', `/api/documents/${id}/`))
    },
    async listTags() {
      return (await getAll<RawTag>('/api/tags/')).map(toTag)
    },
    async listCorrespondents() {
      return (await getAll<RawCorrespondent>('/api/correspondents/')).map(toCorrespondent)
    },
    async listFiledDocuments({ inboxTagId, correspondentId, limit }) {
      const qs = new URLSearchParams({
        tags__id__none: String(inboxTagId),
        ordering: '-added',
        page: '1',
        page_size: String(limit),
      })
      if (correspondentId !== undefined) qs.set('correspondent__id', String(correspondentId))
      else qs.set('correspondent__isnull', 'false')
      const data = await json<Page<RawDocument>>('GET', `/api/documents/?${qs}`)
      return data.results.map(toDocument)
    },
    async createTag(name) {
      // matching_algorithm 0 = "None": Paperless must not auto-assign tags we create.
      return toTag(await json<RawTag>('POST', '/api/tags/', { name, matching_algorithm: 0 }))
    },
    async createCorrespondent(name) {
      return toCorrespondent(await json<RawCorrespondent>('POST', '/api/correspondents/', { name, matching_algorithm: 0 }))
    },
    async updateDocument(id, patch) {
      return toDocument(await json<RawDocument>('PATCH', `/api/documents/${id}/`, patch))
    },
    async fetchFile(id, kind) {
      return send('GET', `/api/documents/${id}/${kind}/`, undefined, '*/*')
    },
  }
}

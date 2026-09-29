import type {
  ApplyRequestBody,
  DocumentDetail,
  StatusResponse,
} from '../../src/api/types'

export class UnauthorizedError extends Error {
  override name = 'UnauthorizedError'
  constructor() {
    super('Not signed in')
  }
}

export class ApiError extends Error {
  override name = 'ApiError'
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message)
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: init.body ? { 'Content-Type': 'application/json' } : undefined,
  })
  if (res.status === 401) throw new UnauthorizedError()
  const body: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const message = (body as { error?: string } | null)?.error ?? `HTTP ${res.status}`
    throw new ApiError(message, res.status, body)
  }
  return body as T
}

export const api = {
  login: (password: string) =>
    request<{ ok: true }>('/api/login', { method: 'POST', body: JSON.stringify({ password }) }),
  status: () => request<StatusResponse>('/api/status'),
  nextDocument: (after?: number) =>
    request<{ documentId: number | null }>(`/api/queue/next${after === undefined ? '' : `?after=${after}`}`),
  document: (id: number) => request<DocumentDetail>(`/api/documents/${id}`),
  apply: (id: number, body: ApplyRequestBody) =>
    request<{ status: 'applied' }>(`/api/documents/${id}/apply`, { method: 'POST', body: JSON.stringify(body) }),
  regenerate: (id: number) => request<{ status: 'pending' }>(`/api/documents/${id}/regenerate`, { method: 'POST' }),
}

export const fileUrl = (id: number, kind: 'thumb' | 'preview') => `/api/documents/${id}/${kind}`

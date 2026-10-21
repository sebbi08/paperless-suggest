import type { DocumentDetail, StatusResponse, StoredSuggestion } from '../../../src/api/types'

export function makeDetail(
  opts: { id?: number; suggestion?: Partial<StoredSuggestion> | null; document?: Partial<DocumentDetail['document']> } = {},
): DocumentDetail {
  const id = opts.id ?? 1
  return {
    document: {
      id,
      title: `scan_${id}`,
      created: '2026-09-14',
      content: `Deutsche Telekom AG Rechnung ${id}`,
      correspondentId: null,
      tagIds: [1],
      modified: `2026-09-14T10:00:0${id}+02:00`,
      added: '2026-09-14T10:00:00+02:00',
      ...opts.document,
    },
    suggestion:
      opts.suggestion === null
        ? null
        : {
            documentId: id,
            status: 'ready',
            title: `Telekom Rechnung ${id}`,
            createdDate: '2026-09-12',
            correspondentId: 10,
            proposedCorrespondent: null,
            tagIds: [2],
            proposedTags: [{ name: 'Mobilfunk', nearest: [{ id: 3, name: 'Telefon/Internet', score: 0.4 }] }],
            matchedNotes: {},
            model: 'qwen3-14b',
            error: null,
            docModified: `2026-09-14T10:00:0${id}+02:00`,
            updatedAt: '2026-09-14T10:01:00.000Z',
            ...opts.suggestion,
          },
    vocabulary: {
      inboxTagId: 1,
      tags: [
        { id: 2, name: 'Rechnung' },
        { id: 3, name: 'Telefon/Internet' },
        { id: 4, name: 'Versicherung' },
        { id: 5, name: 'Müller "Bau"' },
      ],
      correspondents: [
        { id: 10, name: 'Deutsche Telekom AG' },
        { id: 11, name: 'Stadtwerke München GmbH' },
      ],
    },
  }
}

export function makeStatus(overrides: Partial<StatusResponse> = {}): StatusResponse {
  return {
    paperless: { ok: true, error: null },
    llm: { ok: true, model: 'qwen3-14b', error: null },
    lastPollAt: '2026-09-29T10:00:00Z',
    counts: { ready: 2, pending: 3, error: 0, noText: 0 },
    ...overrides,
  }
}

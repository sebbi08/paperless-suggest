import type { ApplyRequest } from '../apply/apply'
import type { PaperlessDocument } from '../paperless/types'
import type { StatusCounts, StoredSuggestion } from '../store/suggestions'
import type { WorkerStatus } from '../worker/worker'

export type { StoredSuggestion, SuggestionStatus } from '../store/suggestions'
export type { NearMatch } from '../suggest/normalize'
export type { Proposal } from '../suggest/types'

export interface NamedRef {
  id: number
  name: string
}

export interface DocumentDetail {
  document: {
    id: number
    title: string
    content: string
    correspondentId: number | null
    tagIds: number[]
    modified: string
    added: string
  }
  suggestion: StoredSuggestion | null
  /** tags exclude the inbox tag */
  vocabulary: { inboxTagId: number; tags: NamedRef[]; correspondents: NamedRef[] }
}

export type StatusResponse = WorkerStatus & { counts: StatusCounts }

export type ApplyRequestBody = ApplyRequest

export type ApplyConflict =
  | { reason: 'modified'; current: PaperlessDocument }
  | { reason: 'missing'; missingTagIds: number[]; missingCorrespondentId: number | null }

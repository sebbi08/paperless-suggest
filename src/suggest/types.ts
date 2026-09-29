import type { Vocabulary } from '../paperless/types'
import type { NearMatch } from './normalize'

export interface Example {
  title: string
  correspondent: string | null
  tags: string[]
  content: string
}

/** A name that does not exist in Paperless yet, with the closest existing names. */
export interface Proposal {
  name: string
  nearest: NearMatch[]
}

export interface Suggestion {
  title: string
  correspondentId: number | null
  proposedCorrespondent: Proposal | null
  tagIds: number[]
  proposedTags: Proposal[]
  /** proposed name → existing name it was auto-mapped to */
  matchedNotes: Record<string, string>
  model: string
}

export type SuggestResult =
  | { kind: 'ok'; suggestion: Suggestion }
  | { kind: 'no_text' }
  | { kind: 'error'; error: string; model: string | null }

export interface SuggestInput {
  content: string
  vocabulary: Vocabulary
  examples: Example[]
  model?: string
}

export interface Suggester {
  /** Rejects with LlmError when the LLM cannot be reached; invalid output resolves as kind 'error'. */
  suggest(input: SuggestInput): Promise<SuggestResult>
}

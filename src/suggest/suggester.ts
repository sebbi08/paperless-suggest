import type { LlmClient } from '../llm/client'
import { selectableTags } from '../paperless/vocabulary'
import type { Vocabulary } from '../paperless/types'
import { normalizeName, rankMatches } from './normalize'
import { buildPrompt, truncateContent } from './prompt'
import { buildSuggestionSchema, parseSuggestionOutput, type RawSuggestion } from './schema'
import type { Proposal, Suggester, Suggestion } from './types'

export const SCHEMA_NAME = 'document_suggestion'
const ATTEMPTS = 2

export interface SuggesterOptions {
  llm: LlmClient
  maxContentChars: number
  matchThreshold: number
}

export function createSuggester(opts: SuggesterOptions): Suggester {
  return {
    async suggest(input) {
      if (!input.content.trim()) return { kind: 'no_text' }
      const content = truncateContent(input.content, opts.maxContentChars)
      const { system, user } = buildPrompt({ content, vocabulary: input.vocabulary, examples: input.examples })
      const schema = buildSuggestionSchema(input.vocabulary)
      let lastError = ''
      let model: string | null = input.model ?? null
      for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        const res = await opts.llm.complete({ system, user, schema, schemaName: SCHEMA_NAME, model: input.model })
        model = res.model
        const parsed = parseSuggestionOutput(res.content, input.vocabulary)
        if (parsed.ok) {
          return {
            kind: 'ok',
            suggestion: resolveSuggestion(parsed.value, input.vocabulary, res.model, opts.matchThreshold),
          }
        }
        lastError = parsed.error
      }
      return { kind: 'error', error: `Invalid model output after ${ATTEMPTS} attempts: ${lastError}`, model }
    },
  }
}

export function resolveSuggestion(raw: RawSuggestion, v: Vocabulary, model: string, threshold: number): Suggestion {
  const tags = selectableTags(v)
  const tagIdByName = new Map(tags.map((t) => [t.name, t.id]))
  const correspondentIdByName = new Map(v.correspondents.map((c) => [c.name, c.id]))
  const matchedNotes: Record<string, string> = {}

  let correspondentId = raw.correspondent === null ? null : (correspondentIdByName.get(raw.correspondent) ?? null)
  let proposedCorrespondent: Proposal | null = null
  if (correspondentId === null && raw.proposed_new_correspondent) {
    const name = raw.proposed_new_correspondent.trim()
    const nearest = rankMatches(name, v.correspondents)
    const best = nearest[0]
    if (best && best.score >= threshold) {
      correspondentId = best.id
      matchedNotes[name] = best.name
    } else {
      proposedCorrespondent = { name, nearest }
    }
  }

  const tagIds = [...new Set(raw.tags.map((n) => tagIdByName.get(n)).filter((id): id is number => id !== undefined))]
  const proposedTags: Proposal[] = []
  for (const rawName of raw.proposed_new_tags) {
    const name = rawName.trim()
    const nearest = rankMatches(name, tags)
    const best = nearest[0]
    if (best && best.score >= threshold) {
      if (!tagIds.includes(best.id)) {
        tagIds.push(best.id)
        matchedNotes[name] = best.name
      }
    } else if (!proposedTags.some((p) => normalizeName(p.name) === normalizeName(name))) {
      proposedTags.push({ name, nearest })
    }
  }

  return { title: raw.title, correspondentId, proposedCorrespondent, tagIds, proposedTags, matchedNotes, model }
}

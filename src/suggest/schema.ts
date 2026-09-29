import { z } from 'zod'
import { selectableTags } from '../paperless/vocabulary'
import type { Vocabulary } from '../paperless/types'

export const TITLE_MAX = 80
const PROPOSED_TAGS_MAX = 2
const TAGS_MAX = 8
const NAME_MAX = 128

export interface RawSuggestion {
  title: string
  correspondent: string | null
  proposed_new_correspondent: string | null
  tags: string[]
  proposed_new_tags: string[]
}

export function buildSuggestionSchema(v: Vocabulary): Record<string, unknown> {
  const tagNames = selectableTags(v).map((t) => t.name)
  const correspondentNames = v.correspondents.map((c) => c.name)
  return {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'correspondent', 'proposed_new_correspondent', 'tags', 'proposed_new_tags'],
    properties: {
      title: { type: 'string', minLength: 1, maxLength: TITLE_MAX },
      correspondent:
        correspondentNames.length > 0
          ? { anyOf: [{ type: 'string', enum: correspondentNames }, { type: 'null' }] }
          : { type: 'null' },
      proposed_new_correspondent: { anyOf: [{ type: 'string', minLength: 1, maxLength: NAME_MAX }, { type: 'null' }] },
      tags:
        tagNames.length > 0
          ? { type: 'array', items: { type: 'string', enum: tagNames }, maxItems: TAGS_MAX }
          : { type: 'array', items: { type: 'string' }, maxItems: 0 },
      proposed_new_tags: {
        type: 'array',
        items: { type: 'string', minLength: 1, maxLength: NAME_MAX },
        maxItems: PROPOSED_TAGS_MAX,
      },
    },
  }
}

/** Removes reasoning blocks, code fences and surrounding prose some models emit. */
export function extractJson(content: string): string {
  let s = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(s)
  if (fenced?.[1]) s = fenced[1].trim()
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  return start >= 0 && end > start ? s.slice(start, end + 1) : s
}

export function parseSuggestionOutput(
  content: string,
  v: Vocabulary,
): { ok: true; value: RawSuggestion } | { ok: false; error: string } {
  let json: unknown
  try {
    json = JSON.parse(extractJson(content))
  } catch {
    return { ok: false, error: `Output is not valid JSON: ${content.slice(0, 120)}` }
  }
  const tagNames = new Set(selectableTags(v).map((t) => t.name))
  const correspondentNames = new Set(v.correspondents.map((c) => c.name))
  const inboxTagId = v.inboxTagId
  const schema = z.object({
    title: z.string().trim().min(1),
    correspondent: z
      .string()
      .nullable()
      .refine((c) => c === null || correspondentNames.has(c), 'unknown correspondent'),
    proposed_new_correspondent: z.string().trim().min(1).nullable().optional(),
    tags: z.array(z.string().refine((t) => {
      // Find the tag by name
      const tag = v.tags.find(tag => tag.name === t)
      // Reject if not found, or if it's the inbox tag
      return tag && tag.id !== inboxTagId
    }, 'unknown tag')),
    proposed_new_tags: z.array(z.string().trim().min(1)).max(PROPOSED_TAGS_MAX).optional(),
  })
  const parsed = schema.safeParse(json)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }
  }
  const p = parsed.data
  return {
    ok: true,
    value: {
      title: p.title.length > TITLE_MAX ? p.title.slice(0, TITLE_MAX).trimEnd() : p.title,
      correspondent: p.correspondent,
      proposed_new_correspondent: p.proposed_new_correspondent ?? null,
      tags: [...new Set(p.tags)],
      proposed_new_tags: p.proposed_new_tags ?? [],
    },
  }
}

# Paperless Suggest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a self-hosted web app that suggests title, correspondent and tags for Paperless-ngx inbox documents using a local LLM in LM Studio. Every change needs manual confirmation, and existing tags and correspondents are strictly preferred.

**Architecture:** One Node/TypeScript service in one Docker container. A background worker polls the Paperless inbox and, whenever LM Studio is reachable, computes suggestions and stores them in SQLite. The suggestions use JSON-schema structured output whose `enum`s contain only existing tag and correspondent names. A Hono HTTP API serves a mobile-friendly React review app. The only place anything is written to Paperless is the Apply action. An `eval` CLI compares candidate models on already-filed documents.

**Tech Stack:** Node 22, TypeScript (ESM), Hono + @hono/node-server, better-sqlite3, zod, openai SDK (pointed at LM Studio), Vite + React 19 + TanStack Query v5 + Tailwind v4, Vitest + msw + React Testing Library, Playwright, tsup, Docker.

**Spec:** `docs/superpowers/specs/2026-09-29-paperless-suggest-design.md`

## Global Constraints

- Node ≥ 22, `"type": "module"`, TypeScript `strict` + `noUncheckedIndexedAccess`.
- One npm package; the frontend lives in `web/`; one build produces one Docker image.
- Paperless requests send `Authorization: Token <PAPERLESS_TOKEN>`; the token never reaches the browser (files are proxied).
- **Nothing is written to Paperless except by `POST /api/documents/:id/apply`.** Apply removes the inbox tag.
- LLM output schema: `title` maxLength 80; `correspondent`/`tags` restricted to existing names via `enum`; `proposed_new_tags` maxItems 2; the inbox tag is never selectable.
- Defaults: `POLL_INTERVAL=300` s, `MAX_CONTENT_CHARS=6000`, `NEW_NAME_MATCH_THRESHOLD=0.85`, `DATA_DIR=/data`, `PORT=3000`; 3 few-shot examples of 800 chars each.
- LLM offline backoff: 60 s, doubling, capped at 600 s. Invalid LLM output: exactly one retry.
- Worker processes one document at a time.
- Session cookie `ps_session`: HttpOnly, `SameSite=Lax`, `Secure` when served over HTTPS, Max-Age 30 days. Login is rate-limited to 10 failures per 15 minutes.
- Desktop layout breakpoint: 900 px (Tailwind custom breakpoint `desk`).
- Paperless title limit: 128 characters.
- Commit messages: conventional prefix (`feat:`, `test:`, `chore:`, `docs:`), ending with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (passed as a second `-m`).

## Review Focus

1. **Model output wrapped in reasoning or code fences** (Qwen3 `<think>…</think>`, ```` ```json ```` fences) must still parse, not burn the retry and end in `error`. Pinned in Task 5.
2. **Tag or correspondent names with special characters** (`Telefon/Internet`, `Müller "Bau"`, umlauts) must round-trip exactly through the schema `enum`, validation, and the UI. Pinned in Task 5 (schema/parse) and Task 14 (chip rendering).
3. **An empty vocabulary** (fresh Paperless: no correspondents, only the inbox tag) must still produce a valid schema and a suggestion, with everything as NEW proposals. Pinned in Task 5 and Task 7.
4. **Tags already on the document** (set by Paperless matching rules at upload) must not be silently dropped on Apply unless the user removes them. Pinned in Task 13 (`initialEditState` union).
5. **Applying the same document twice from two devices** (phone and desktop) must produce a 409 conflict the second time, never a second write. Pinned in Task 10.

---

## File Structure

```
package.json, tsconfig.json, vitest.config.ts, vitest.setup.ts, tsup.config.ts,
playwright.config.ts, .env.example, .dockerignore, Dockerfile,
docker-compose.example.yml, README.md

src/
  config.ts                 env → Config (zod), ConfigError
  server.ts                 process entry: wires everything, starts HTTP + worker
  paperless/
    types.ts                PaperlessDocument, PaperlessTag, PaperlessCorrespondent, DocumentPatch, Vocabulary
    client.ts               PaperlessClient (REST wrapper), PaperlessError
    vocabulary.ts           loadVocabulary, resolveInboxTag, selectableTags, hashVocabulary, InboxTagError
  llm/
    client.ts               LlmClient (OpenAI SDK → LM Studio), LlmError
  suggest/
    types.ts                Example, Proposal, Suggestion, SuggestResult, Suggester
    normalize.ts            normalizeName, nameSimilarity, rankMatches
    schema.ts               buildSuggestionSchema, parseSuggestionOutput, extractJson
    prompt.ts               buildPrompt, truncateContent, guessCorrespondent
    examples.ts             loadExamples, toExample
    suggester.ts            createSuggester, resolveSuggestion
  store/
    db.ts                   openDb (+ schema migration)
    suggestions.ts          SuggestionStore
  worker/
    worker.ts               Worker (poll loop, backoff, status), hashContent
  apply/
    apply.ts                ApplyRequestSchema, applySuggestion
  api/
    types.ts                DTOs shared with the web app
    auth.ts                 createAuth (login/logout/middleware)
    static.ts               serveSpa (static files + SPA fallback)
    app.ts                  createApp (all HTTP routes)
  eval/
    metrics.ts              summarize, checkTitle, detectLanguage
    report.ts               renderReport (HTML)
    run.ts                  CLI: parseArgs, pickSample, runEval, main

web/
  index.html, vite.config.ts
  src/
    main.tsx, index.css, App.tsx
    api.ts                  fetch wrapper, UnauthorizedError, ApiError
    editState.ts            pure edit-state logic for the review form
    TagEditor.tsx, CorrespondentPicker.tsx
    ReviewScreen.tsx        queue navigation + ReviewForm (keyboard shortcuts)
    Preview.tsx, StatusBar.tsx, EmptyState.tsx, Login.tsx
    test/fixtures.ts

tests/                      server tests, mirroring src/
  helpers/fixtures.ts, helpers/fakes.ts, helpers/msw.ts
e2e/review.spec.ts
```

---

### Task 1: Project scaffold and configuration

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.env.example`
- Create: `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  ```ts
  export class ConfigError extends Error {}
  export interface Config { paperlessUrl: string; paperlessToken: string; llmBaseUrl: string; llmModel: string | null; inboxTag: string | null; appPassword: string | null; authDisabled: boolean; pollIntervalSec: number; maxContentChars: number; newNameMatchThreshold: number; dataDir: string; port: number }
  export function loadConfig(env: Record<string, string | undefined>, opts?: { requireAuth?: boolean }): Config
  ```

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "paperless-suggest",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "dev:web": "vite --config web/vite.config.ts",
    "build": "vite build --config web/vite.config.ts && tsup",
    "start": "node dist/server.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test",
    "typecheck": "tsc --noEmit",
    "eval": "tsx src/eval/run.ts"
  }
}
```

- [ ] **Step 2: Extend `.gitignore` and install dependencies**

Append these lines to the existing `.gitignore`:
```
data/
.tmp-data/
test-results/
playwright-report/
```

Run:
```bash
npm i hono @hono/node-server better-sqlite3 zod openai
npm i -D typescript tsx tsup vitest @types/node @types/better-sqlite3 msw
```
Expected: installs succeed and `package-lock.json` is created.

- [ ] **Step 3: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "tests", "web/src", "e2e", "*.config.ts", "vitest.setup.ts"]
}
```

- [ ] **Step 4: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'web/src/**/*.test.{ts,tsx}'],
  },
})
```

- [ ] **Step 5: Create `.env.example`**

```
PAPERLESS_URL=http://paperless:8000
PAPERLESS_TOKEN=
LLM_BASE_URL=http://192.168.1.50:1234/v1
# LLM_MODEL=qwen3-14b
# INBOX_TAG=Inbox
APP_PASSWORD=
# AUTH_DISABLED=false
# POLL_INTERVAL=300
# MAX_CONTENT_CHARS=6000
# NEW_NAME_MATCH_THRESHOLD=0.85
DATA_DIR=./data
# PORT=3000
```

- [ ] **Step 6: Write the failing test `tests/config.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from '../src/config'

const base = {
  PAPERLESS_URL: 'http://paperless:8000/',
  PAPERLESS_TOKEN: 'tok',
  LLM_BASE_URL: 'http://pc:1234/v1/',
  APP_PASSWORD: 'pw',
}

describe('loadConfig', () => {
  it('applies defaults and strips trailing slashes', () => {
    expect(loadConfig(base)).toEqual({
      paperlessUrl: 'http://paperless:8000',
      paperlessToken: 'tok',
      llmBaseUrl: 'http://pc:1234/v1',
      llmModel: null,
      inboxTag: null,
      appPassword: 'pw',
      authDisabled: false,
      pollIntervalSec: 300,
      maxContentChars: 6000,
      newNameMatchThreshold: 0.85,
      dataDir: '/data',
      port: 3000,
    })
  })

  it('names every missing required variable', () => {
    let message = ''
    try {
      loadConfig({})
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError)
      message = (e as Error).message
    }
    expect(message).toContain('PAPERLESS_URL')
    expect(message).toContain('PAPERLESS_TOKEN')
    expect(message).toContain('LLM_BASE_URL')
  })

  it('treats empty strings as missing', () => {
    expect(() => loadConfig({ ...base, PAPERLESS_TOKEN: '  ' })).toThrow(/PAPERLESS_TOKEN/)
  })

  it('requires APP_PASSWORD unless AUTH_DISABLED is true', () => {
    const { APP_PASSWORD: _unused, ...noPassword } = base
    expect(() => loadConfig(noPassword)).toThrow(/APP_PASSWORD/)
    expect(loadConfig({ ...noPassword, AUTH_DISABLED: 'true' }).authDisabled).toBe(true)
  })

  it('does not require APP_PASSWORD when requireAuth is false', () => {
    const { APP_PASSWORD: _unused, ...noPassword } = base
    expect(loadConfig(noPassword, { requireAuth: false }).appPassword).toBeNull()
  })

  it('parses optional values and numeric overrides', () => {
    const c = loadConfig({
      ...base,
      LLM_MODEL: 'qwen3-14b',
      INBOX_TAG: 'Posteingang',
      POLL_INTERVAL: '60',
      MAX_CONTENT_CHARS: '4000',
      NEW_NAME_MATCH_THRESHOLD: '0.9',
      DATA_DIR: './data',
      PORT: '8080',
    })
    expect(c).toMatchObject({
      llmModel: 'qwen3-14b',
      inboxTag: 'Posteingang',
      pollIntervalSec: 60,
      maxContentChars: 4000,
      newNameMatchThreshold: 0.9,
      dataDir: './data',
      port: 8080,
    })
  })

  it('rejects an out-of-range threshold', () => {
    expect(() => loadConfig({ ...base, NEW_NAME_MATCH_THRESHOLD: '1.5' })).toThrow(/NEW_NAME_MATCH_THRESHOLD/)
  })
})
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL, because `../src/config` cannot be resolved.

- [ ] **Step 8: Implement `src/config.ts`**

```ts
import { z } from 'zod'

export class ConfigError extends Error {
  override name = 'ConfigError'
}

export interface Config {
  paperlessUrl: string
  paperlessToken: string
  llmBaseUrl: string
  llmModel: string | null
  inboxTag: string | null
  appPassword: string | null
  authDisabled: boolean
  pollIntervalSec: number
  maxContentChars: number
  newNameMatchThreshold: number
  dataDir: string
  port: number
}

const EnvSchema = z.object({
  PAPERLESS_URL: z.string().url(),
  PAPERLESS_TOKEN: z.string().min(1),
  LLM_BASE_URL: z.string().url(),
  LLM_MODEL: z.string().optional(),
  INBOX_TAG: z.string().optional(),
  APP_PASSWORD: z.string().optional(),
  AUTH_DISABLED: z.enum(['true', 'false', '1', '0']).optional(),
  POLL_INTERVAL: z.coerce.number().int().positive().default(300),
  MAX_CONTENT_CHARS: z.coerce.number().int().positive().default(6000),
  NEW_NAME_MATCH_THRESHOLD: z.coerce.number().min(0).max(1).default(0.85),
  DATA_DIR: z.string().default('/data'),
  PORT: z.coerce.number().int().positive().default(3000),
})

const stripSlash = (url: string) => url.replace(/\/+$/, '')

export function loadConfig(
  env: Record<string, string | undefined>,
  opts: { requireAuth?: boolean } = {},
): Config {
  const requireAuth = opts.requireAuth ?? true
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ''),
  )
  const parsed = EnvSchema.safeParse(cleaned)
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
    throw new ConfigError(`Invalid configuration:\n${lines.join('\n')}`)
  }
  const e = parsed.data
  const authDisabled = e.AUTH_DISABLED === 'true' || e.AUTH_DISABLED === '1'
  if (requireAuth && !authDisabled && !e.APP_PASSWORD) {
    throw new ConfigError('Invalid configuration:\nAPP_PASSWORD: required unless AUTH_DISABLED=true')
  }
  return {
    paperlessUrl: stripSlash(e.PAPERLESS_URL),
    paperlessToken: e.PAPERLESS_TOKEN,
    llmBaseUrl: stripSlash(e.LLM_BASE_URL),
    llmModel: e.LLM_MODEL ?? null,
    inboxTag: e.INBOX_TAG ?? null,
    appPassword: e.APP_PASSWORD ?? null,
    authDisabled,
    pollIntervalSec: e.POLL_INTERVAL,
    maxContentChars: e.MAX_CONTENT_CHARS,
    newNameMatchThreshold: e.NEW_NAME_MATCH_THRESHOLD,
    dataDir: e.DATA_DIR,
    port: e.PORT,
  }
}
```

- [ ] **Step 9: Run tests and typecheck**

Run: `npx vitest run tests/config.test.ts && npm run typecheck`
Expected: 7 tests PASS; `tsc` exits 0.

- [ ] **Step 10: Commit**

```bash
git add .gitignore package.json package-lock.json tsconfig.json vitest.config.ts .env.example src/config.ts tests/config.test.ts
git commit -m "feat: project scaffold and env configuration" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Name normalization and fuzzy matching

**Files:**
- Create: `src/suggest/normalize.ts`
- Test: `tests/suggest/normalize.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces (pure, no Node APIs, so the web app imports it too):
  ```ts
  export interface NamedEntity { id: number; name: string }
  export interface NearMatch { id: number; name: string; score: number }
  export function normalizeName(name: string): string
  export function nameSimilarity(a: string, b: string): number   // 0..1
  export function rankMatches(name: string, candidates: NamedEntity[], limit?: number): NearMatch[] // default limit 3, score > 0 only, best first
  ```

- [ ] **Step 1: Write the failing test `tests/suggest/normalize.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { nameSimilarity, normalizeName, rankMatches } from '../../src/suggest/normalize'

describe('normalizeName', () => {
  it('lowercases, folds umlauts and strips punctuation', () => {
    expect(normalizeName('Stadtwerke München')).toBe('stadtwerke muenchen')
    expect(normalizeName('Straße & Söhne')).toBe('strasse soehne')
    expect(normalizeName('Café Olé')).toBe('cafe ole')
  })

  it('removes legal suffixes', () => {
    expect(normalizeName('Deutsche Telekom AG')).toBe('deutsche telekom')
    expect(normalizeName('Müller GmbH & Co. KG')).toBe('mueller')
    expect(normalizeName('Acme Inc.')).toBe('acme')
  })

  it('keeps a name that consists only of a suffix-like token', () => {
    expect(normalizeName('AG')).toBe('ag')
  })
})

describe('nameSimilarity', () => {
  it('is 1 for names equal after normalization', () => {
    expect(nameSimilarity('Stadtwerke München GmbH', 'stadtwerke muenchen')).toBe(1)
  })

  it('is 0.9 when all tokens of the shorter name are contained in the longer', () => {
    expect(nameSimilarity('Telekom', 'Deutsche Telekom AG')).toBe(0.9)
  })

  it('scores near-identical words high', () => {
    expect(nameSimilarity('Rechnungen', 'Rechnung')).toBeGreaterThanOrEqual(0.85)
  })

  it('scores unrelated words low', () => {
    expect(nameSimilarity('Versicherung', 'Rechnung')).toBeLessThan(0.5)
  })

  it('is 0 for empty input', () => {
    expect(nameSimilarity('', 'Rechnung')).toBe(0)
  })
})

describe('rankMatches', () => {
  const tags = [
    { id: 1, name: 'Rechnung' },
    { id: 2, name: 'Versicherung' },
    { id: 3, name: 'Telefon/Internet' },
    { id: 4, name: 'Steuer' },
  ]

  it('returns the best matches first, limited', () => {
    const r = rankMatches('Rechnungen', tags, 2)
    expect(r).toHaveLength(2)
    expect(r[0]).toMatchObject({ id: 1, name: 'Rechnung' })
    expect(r[0]!.score).toBeGreaterThan(r[1]!.score)
  })

  it('drops candidates with score 0', () => {
    expect(rankMatches('xyz', tags)).toEqual([])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/suggest/normalize.test.ts`
Expected: FAIL, because the module does not exist.

- [ ] **Step 3: Implement `src/suggest/normalize.ts`**

```ts
export interface NamedEntity {
  id: number
  name: string
}

export interface NearMatch {
  id: number
  name: string
  score: number
}

const LEGAL_SUFFIXES = new Set([
  'ag', 'gmbh', 'mbh', 'co', 'kg', 'ohg', 'se', 'ug', 'ev',
  'inc', 'ltd', 'llc', 'plc', 'corp', 'sa', 'bv',
])

export function normalizeName(name: string): string {
  const folded = name
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
  const tokens = folded.replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean)
  const kept = tokens.filter((t) => !LEGAL_SUFFIXES.has(t))
  return (kept.length > 0 ? kept : tokens).join(' ')
}

function bigrams(s: string): Map<string, number> {
  const compact = s.replace(/ /g, '')
  const out = new Map<string, number>()
  for (let i = 0; i < compact.length - 1; i++) {
    const g = compact.slice(i, i + 2)
    out.set(g, (out.get(g) ?? 0) + 1)
  }
  return out
}

function dice(a: string, b: string): number {
  const ga = bigrams(a)
  const gb = bigrams(b)
  let total = 0
  for (const n of ga.values()) total += n
  for (const n of gb.values()) total += n
  if (total === 0) return a === b ? 1 : 0
  let overlap = 0
  for (const [g, n] of ga) overlap += Math.min(n, gb.get(g) ?? 0)
  return (2 * overlap) / total
}

export function nameSimilarity(a: string, b: string): number {
  const na = normalizeName(a)
  const nb = normalizeName(b)
  if (!na || !nb) return 0
  if (na === nb) return 1
  const ta = na.split(' ')
  const tb = nb.split(' ')
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta]
  if (short.join('').length >= 4 && short.every((t) => long.includes(t))) return 0.9
  return dice(na, nb)
}

export function rankMatches(name: string, candidates: NamedEntity[], limit = 3): NearMatch[] {
  return candidates
    .map((c) => ({ id: c.id, name: c.name, score: nameSimilarity(name, c.name) }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/suggest/normalize.test.ts`
Expected: 10 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/suggest/normalize.ts tests/suggest/normalize.test.ts
git commit -m "feat: name normalization and fuzzy matching" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Paperless client and vocabulary

**Files:**
- Create: `src/paperless/types.ts`, `src/paperless/client.ts`, `src/paperless/vocabulary.ts`
- Create: `tests/helpers/msw.ts`, `tests/helpers/fixtures.ts`
- Test: `tests/paperless/client.test.ts`, `tests/paperless/vocabulary.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  ```ts
  // types.ts
  export interface PaperlessDocument { id: number; title: string; content: string; correspondent: number | null; tags: number[]; created: string; added: string; modified: string }
  export interface PaperlessTag { id: number; name: string; isInboxTag: boolean; documentCount: number }
  export interface PaperlessCorrespondent { id: number; name: string; documentCount: number }
  export interface DocumentPatch { title?: string; correspondent?: number | null; tags?: number[] }
  export interface Vocabulary { inboxTagId: number; tags: PaperlessTag[]; correspondents: PaperlessCorrespondent[] } // tags include the inbox tag

  // client.ts
  export class PaperlessError extends Error { readonly status: number | null }
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
  export function createPaperlessClient(opts: { baseUrl: string; token: string }): PaperlessClient

  // vocabulary.ts
  export class InboxTagError extends Error {}
  export function resolveInboxTag(tags: PaperlessTag[], inboxTag: string | null): PaperlessTag
  export function loadVocabulary(client: Pick<PaperlessClient, 'listTags' | 'listCorrespondents'>, inboxTag: string | null): Promise<Vocabulary>
  export function selectableTags(v: Vocabulary): PaperlessTag[]   // all tags except the inbox tag
  export function hashVocabulary(v: Vocabulary): string           // ids + names only, NOT document counts

  // tests/helpers/fixtures.ts
  export const INBOX_ID = 1
  export function makeVocabulary(): Vocabulary
  export function makeDocument(overrides?: Partial<PaperlessDocument>): PaperlessDocument
  // tests/helpers/msw.ts
  export function useMswServer(): SetupServerApi
  ```

- [ ] **Step 1: Create the test helpers**

`tests/helpers/msw.ts`:
```ts
import { setupServer, type SetupServerApi } from 'msw/node'
import { afterAll, afterEach, beforeAll } from 'vitest'

export function useMswServer(): SetupServerApi {
  const server = setupServer()
  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
  afterEach(() => server.resetHandlers())
  afterAll(() => server.close())
  return server
}
```

`tests/helpers/fixtures.ts`:
```ts
import type { PaperlessDocument, Vocabulary } from '../../src/paperless/types'

export const INBOX_ID = 1

export function makeVocabulary(): Vocabulary {
  return {
    inboxTagId: INBOX_ID,
    tags: [
      { id: 1, name: 'Inbox', isInboxTag: true, documentCount: 4 },
      { id: 2, name: 'Rechnung', isInboxTag: false, documentCount: 120 },
      { id: 3, name: 'Telefon/Internet', isInboxTag: false, documentCount: 14 },
      { id: 4, name: 'Versicherung', isInboxTag: false, documentCount: 30 },
      { id: 5, name: 'Müller "Bau"', isInboxTag: false, documentCount: 2 },
    ],
    correspondents: [
      { id: 10, name: 'Deutsche Telekom AG', documentCount: 30 },
      { id: 11, name: 'Stadtwerke München GmbH', documentCount: 12 },
      { id: 12, name: 'Allianz Versicherung', documentCount: 8 },
    ],
  }
}

export function makeDocument(overrides: Partial<PaperlessDocument> = {}): PaperlessDocument {
  return {
    id: 100,
    title: 'scan_0001',
    content: 'Deutsche Telekom AG\nRechnung September 2026\nBetrag 39,95 €',
    correspondent: null,
    tags: [INBOX_ID],
    created: '2026-09-14T00:00:00+02:00',
    added: '2026-09-14T10:00:00+02:00',
    modified: '2026-09-14T10:00:05+02:00',
    ...overrides,
  }
}
```

- [ ] **Step 2: Create `src/paperless/types.ts`**

```ts
export interface PaperlessDocument {
  id: number
  title: string
  content: string
  correspondent: number | null
  tags: number[]
  created: string
  added: string
  modified: string
}

export interface PaperlessTag {
  id: number
  name: string
  isInboxTag: boolean
  documentCount: number
}

export interface PaperlessCorrespondent {
  id: number
  name: string
  documentCount: number
}

export interface DocumentPatch {
  title?: string
  correspondent?: number | null
  tags?: number[]
}

/** Current tags (including the inbox tag) and correspondents. */
export interface Vocabulary {
  inboxTagId: number
  tags: PaperlessTag[]
  correspondents: PaperlessCorrespondent[]
}
```

- [ ] **Step 3: Write the failing client test `tests/paperless/client.test.ts`**

```ts
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
    await client().updateDocument(5, { title: 'T', correspondent: null, tags: [2] })
    expect(patchBody).toEqual({ title: 'T', correspondent: null, tags: [2] })
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
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run tests/paperless/client.test.ts`
Expected: FAIL, because `../../src/paperless/client` cannot be resolved.

- [ ] **Step 5: Implement `src/paperless/client.ts`**

```ts
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
```

- [ ] **Step 6: Run the client test to verify it passes**

Run: `npx vitest run tests/paperless/client.test.ts`
Expected: 7 tests PASS.

- [ ] **Step 7: Write the failing vocabulary test `tests/paperless/vocabulary.test.ts`**

```ts
import { describe, expect, it, vi } from 'vitest'
import {
  hashVocabulary,
  InboxTagError,
  loadVocabulary,
  resolveInboxTag,
  selectableTags,
} from '../../src/paperless/vocabulary'
import { makeVocabulary } from '../helpers/fixtures'

describe('resolveInboxTag', () => {
  const tags = makeVocabulary().tags

  it('uses the tag flagged as inbox tag by default', () => {
    expect(resolveInboxTag(tags, null).id).toBe(1)
  })

  it('resolves INBOX_TAG by id or case-insensitive name', () => {
    expect(resolveInboxTag(tags, '4').name).toBe('Versicherung')
    expect(resolveInboxTag(tags, 'rechnung').id).toBe(2)
  })

  it('throws InboxTagError when nothing matches', () => {
    expect(() => resolveInboxTag(tags, 'Nope')).toThrow(InboxTagError)
    expect(() => resolveInboxTag(tags.filter((t) => !t.isInboxTag), null)).toThrow(/INBOX_TAG/)
  })
})

describe('loadVocabulary', () => {
  it('loads tags and correspondents and resolves the inbox tag', async () => {
    const v = makeVocabulary()
    const client = { listTags: vi.fn(async () => v.tags), listCorrespondents: vi.fn(async () => v.correspondents) }
    expect(await loadVocabulary(client, null)).toEqual(v)
  })
})

describe('selectableTags', () => {
  it('excludes the inbox tag', () => {
    expect(selectableTags(makeVocabulary()).map((t) => t.id)).toEqual([2, 3, 4, 5])
  })
})

describe('hashVocabulary', () => {
  it('ignores document counts and order', () => {
    const a = makeVocabulary()
    const b = makeVocabulary()
    b.tags.reverse()
    b.tags[0]!.documentCount = 999
    expect(hashVocabulary(a)).toBe(hashVocabulary(b))
  })

  it('changes when a name changes or a tag is added', () => {
    const a = makeVocabulary()
    const renamed = makeVocabulary()
    renamed.tags[1]!.name = 'Rechnungen'
    const added = makeVocabulary()
    added.correspondents.push({ id: 99, name: 'Neu', documentCount: 0 })
    expect(hashVocabulary(renamed)).not.toBe(hashVocabulary(a))
    expect(hashVocabulary(added)).not.toBe(hashVocabulary(a))
  })
})
```

- [ ] **Step 8: Run the test to verify it fails**

Run: `npx vitest run tests/paperless/vocabulary.test.ts`
Expected: FAIL, because the module does not exist.

- [ ] **Step 9: Implement `src/paperless/vocabulary.ts`**

```ts
import { createHash } from 'node:crypto'
import type { PaperlessClient } from './client'
import type { PaperlessTag, Vocabulary } from './types'

export class InboxTagError extends Error {
  override name = 'InboxTagError'
}

export function resolveInboxTag(tags: PaperlessTag[], inboxTag: string | null): PaperlessTag {
  if (inboxTag !== null) {
    const byId = /^\d+$/.test(inboxTag) ? tags.find((t) => t.id === Number(inboxTag)) : undefined
    const found = byId ?? tags.find((t) => t.name.toLowerCase() === inboxTag.toLowerCase())
    if (!found) throw new InboxTagError(`INBOX_TAG "${inboxTag}" does not match any Paperless tag`)
    return found
  }
  const flagged = tags.find((t) => t.isInboxTag)
  if (!flagged) throw new InboxTagError('No Paperless tag is marked as inbox tag; set INBOX_TAG')
  return flagged
}

export async function loadVocabulary(
  client: Pick<PaperlessClient, 'listTags' | 'listCorrespondents'>,
  inboxTag: string | null,
): Promise<Vocabulary> {
  const [tags, correspondents] = await Promise.all([client.listTags(), client.listCorrespondents()])
  return { inboxTagId: resolveInboxTag(tags, inboxTag).id, tags, correspondents }
}

export function selectableTags(v: Vocabulary): PaperlessTag[] {
  return v.tags.filter((t) => t.id !== v.inboxTagId)
}

/** Hash of ids and names only; document counts change on every apply and must not invalidate suggestions. */
export function hashVocabulary(v: Vocabulary): string {
  const parts = [
    `inbox:${v.inboxTagId}`,
    ...[...v.tags].sort((a, b) => a.id - b.id).map((t) => `t${t.id}:${t.name}`),
    ...[...v.correspondents].sort((a, b) => a.id - b.id).map((c) => `c${c.id}:${c.name}`),
  ]
  return createHash('sha256').update(parts.join('\n')).digest('hex')
}
```

- [ ] **Step 10: Run all tests and typecheck**

Run: `npx vitest run tests/paperless && npm run typecheck`
Expected: all PASS; `tsc` exits 0.

- [ ] **Step 11: Commit**

```bash
git add src/paperless tests/paperless tests/helpers
git commit -m "feat: Paperless REST client and vocabulary helpers" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: LLM client (LM Studio)

**Files:**
- Create: `src/llm/client.ts`
- Test: `tests/llm/client.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  ```ts
  export interface LlmRequest { system: string; user: string; schemaName: string; schema: Record<string, unknown>; model?: string }
  export interface LlmResponse { content: string; model: string }
  export type LlmHealth = { ok: true; model: string } | { ok: false; error: string }
  export interface LlmClient { complete(req: LlmRequest): Promise<LlmResponse>; health(): Promise<LlmHealth> }
  export class LlmError extends Error {}   // thrown by complete() for transport/HTTP failures
  export function createLlmClient(opts: { baseUrl: string; model: string | null; timeoutMs?: number }): LlmClient
  ```
  `health()` never throws. `complete()` uses `req.model`, then the configured model, then the loaded model found by the last `health()`.

Background: LM Studio exposes an OpenAI-compatible API under `/v1` and a native REST API under `/api/v0/models` that reports each model's `state` (`loaded` / `not-loaded`) and `type` (`llm` / `embeddings`). With JIT loading (on by default), requesting a model id that isn't loaded loads it.

- [ ] **Step 1: Write the failing test `tests/llm/client.test.ts`**

```ts
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { createLlmClient, LlmError } from '../../src/llm/client'
import { useMswServer } from '../helpers/msw'

const ROOT = 'http://lmstudio.test:1234'
const BASE = `${ROOT}/v1`
const server = useMswServer()

const modelsList = http.get(`${BASE}/models`, () =>
  HttpResponse.json({ object: 'list', data: [{ id: 'qwen3-14b', object: 'model', owned_by: 'me', created: 0 }] }),
)
const v0Models = (data: unknown[]) => http.get(`${ROOT}/api/v0/models`, () => HttpResponse.json({ data }))
const completion = (content: string) => ({
  id: 'c1',
  object: 'chat.completion',
  created: 0,
  model: 'qwen3-14b',
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop', logprobs: null }],
})

describe('LlmClient.health', () => {
  it('reports the loaded LLM (ignoring embedding models)', async () => {
    server.use(
      modelsList,
      v0Models([
        { id: 'nomic-embed', type: 'embeddings', state: 'loaded' },
        { id: 'gemma-3-12b', type: 'llm', state: 'not-loaded' },
        { id: 'qwen3-14b', type: 'llm', state: 'loaded' },
      ]),
    )
    expect(await createLlmClient({ baseUrl: BASE, model: null }).health()).toEqual({ ok: true, model: 'qwen3-14b' })
  })

  it('prefers the configured model', async () => {
    server.use(modelsList)
    expect(await createLlmClient({ baseUrl: BASE, model: 'gemma-3-12b' }).health()).toEqual({ ok: true, model: 'gemma-3-12b' })
  })

  it('is not ok when no model is loaded and none configured', async () => {
    server.use(modelsList, v0Models([{ id: 'gemma-3-12b', type: 'llm', state: 'not-loaded' }]))
    const h = await createLlmClient({ baseUrl: BASE, model: null }).health()
    expect(h).toEqual({ ok: false, error: expect.stringMatching(/No model loaded/) })
  })

  it('is not ok when LM Studio is unreachable', async () => {
    server.use(http.get(`${BASE}/models`, () => HttpResponse.error()))
    const h = await createLlmClient({ baseUrl: BASE, model: 'x' }).health()
    expect(h).toEqual({ ok: false, error: expect.stringMatching(/unreachable/) })
  })
})

describe('LlmClient.complete', () => {
  it('sends a strict json_schema response_format and returns the content', async () => {
    let body: Record<string, unknown> = {}
    server.use(
      http.post(`${BASE}/chat/completions`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>
        return HttpResponse.json(completion('{"title":"x"}'))
      }),
    )
    const llm = createLlmClient({ baseUrl: BASE, model: 'qwen3-14b' })
    const res = await llm.complete({ system: 'sys', user: 'usr', schemaName: 'doc', schema: { type: 'object' } })
    expect(res).toEqual({ content: '{"title":"x"}', model: 'qwen3-14b' })
    expect(body).toMatchObject({
      model: 'qwen3-14b',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'usr' },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'doc', strict: true, schema: { type: 'object' } } },
    })
  })

  it('uses the per-request model override', async () => {
    let model = ''
    server.use(
      http.post(`${BASE}/chat/completions`, async ({ request }) => {
        model = ((await request.json()) as { model: string }).model
        return HttpResponse.json(completion('{}'))
      }),
    )
    await createLlmClient({ baseUrl: BASE, model: 'a' }).complete({ system: '', user: '', schemaName: 'd', schema: {}, model: 'b' })
    expect(model).toBe('b')
  })

  it('throws LlmError without any model', async () => {
    const llm = createLlmClient({ baseUrl: BASE, model: null })
    await expect(llm.complete({ system: '', user: '', schemaName: 'd', schema: {} })).rejects.toBeInstanceOf(LlmError)
  })

  it('wraps HTTP failures in LlmError', async () => {
    server.use(http.post(`${BASE}/chat/completions`, () => HttpResponse.json({ error: 'boom' }, { status: 500 })))
    const llm = createLlmClient({ baseUrl: BASE, model: 'm' })
    await expect(llm.complete({ system: '', user: '', schemaName: 'd', schema: {} })).rejects.toBeInstanceOf(LlmError)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/llm/client.test.ts`
Expected: FAIL, because the module does not exist.

- [ ] **Step 3: Implement `src/llm/client.ts`**

```ts
import OpenAI from 'openai'

export interface LlmRequest {
  system: string
  user: string
  schemaName: string
  schema: Record<string, unknown>
  model?: string
}

export interface LlmResponse {
  content: string
  model: string
}

export type LlmHealth = { ok: true; model: string } | { ok: false; error: string }

export interface LlmClient {
  complete(req: LlmRequest): Promise<LlmResponse>
  health(): Promise<LlmHealth>
}

export class LlmError extends Error {
  override name = 'LlmError'
}

interface LmStudioModel {
  id: string
  type?: string
  state?: string
}

export function createLlmClient(opts: { baseUrl: string; model: string | null; timeoutMs?: number }): LlmClient {
  const baseUrl = opts.baseUrl.replace(/\/+$/, '')
  const root = baseUrl.replace(/\/v1$/, '')
  const openai = new OpenAI({
    baseURL: baseUrl,
    apiKey: 'lm-studio',
    timeout: opts.timeoutMs ?? 300_000,
    maxRetries: 0,
  })
  let loadedModel: string | null = null

  async function findLoadedModel(): Promise<string | null> {
    const res = await fetch(`${root}/api/v0/models`, { signal: AbortSignal.timeout(5_000) })
    if (!res.ok) return null
    const body = (await res.json()) as { data?: LmStudioModel[] }
    return body.data?.find((m) => m.state === 'loaded' && m.type !== 'embeddings')?.id ?? null
  }

  return {
    async health() {
      try {
        await openai.models.list()
      } catch (e) {
        return { ok: false, error: `LM Studio unreachable: ${(e as Error).message}` }
      }
      if (opts.model) return { ok: true, model: opts.model }
      loadedModel = await findLoadedModel().catch(() => null)
      if (!loadedModel) return { ok: false, error: 'No model loaded in LM Studio and LLM_MODEL is not set' }
      return { ok: true, model: loadedModel }
    },

    async complete(req) {
      const model = req.model ?? opts.model ?? loadedModel
      if (!model) throw new LlmError('No model selected: set LLM_MODEL or load a model in LM Studio')
      let res: OpenAI.Chat.Completions.ChatCompletion
      try {
        res = await openai.chat.completions.create({
          model,
          temperature: 0.2,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: { name: req.schemaName, strict: true, schema: req.schema },
          },
        })
      } catch (e) {
        throw new LlmError(`LLM request failed: ${(e as Error).message}`)
      }
      const content = res.choices[0]?.message?.content
      if (!content) throw new LlmError('LLM returned an empty response')
      return { content, model: res.model || model }
    },
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/llm/client.test.ts && npm run typecheck`
Expected: 8 tests PASS; `tsc` exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/llm tests/llm
git commit -m "feat: LM Studio LLM client with structured output and health check" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 5: Suggestion types, JSON schema and output validation

**Files:**
- Create: `src/suggest/types.ts`, `src/suggest/schema.ts`
- Test: `tests/suggest/schema.test.ts`

**Interfaces:**
- Consumes: `Vocabulary`, `PaperlessTag` (Task 3); `selectableTags` (Task 3); `NearMatch` (Task 2)
- Produces:
  ```ts
  // types.ts
  export interface Example { title: string; correspondent: string | null; tags: string[]; content: string }
  export interface Proposal { name: string; nearest: NearMatch[] }
  export interface Suggestion { title: string; correspondentId: number | null; proposedCorrespondent: Proposal | null; tagIds: number[]; proposedTags: Proposal[]; matchedNotes: Record<string, string>; model: string }
  export type SuggestResult = { kind: 'ok'; suggestion: Suggestion } | { kind: 'no_text' } | { kind: 'error'; error: string; model: string | null }
  export interface SuggestInput { content: string; vocabulary: Vocabulary; examples: Example[]; model?: string }
  export interface Suggester { suggest(input: SuggestInput): Promise<SuggestResult> }  // rejects with LlmError on transport failure

  // schema.ts
  export const TITLE_MAX = 80
  export interface RawSuggestion { title: string; correspondent: string | null; proposed_new_correspondent: string | null; tags: string[]; proposed_new_tags: string[] }
  export function buildSuggestionSchema(v: Vocabulary): Record<string, unknown>
  export function extractJson(content: string): string
  export function parseSuggestionOutput(content: string, v: Vocabulary): { ok: true; value: RawSuggestion } | { ok: false; error: string }
  ```

- [ ] **Step 1: Create `src/suggest/types.ts`**

```ts
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
```

- [ ] **Step 2: Write the failing test `tests/suggest/schema.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { buildSuggestionSchema, extractJson, parseSuggestionOutput, TITLE_MAX } from '../../src/suggest/schema'
import type { Vocabulary } from '../../src/paperless/types'
import { makeVocabulary } from '../helpers/fixtures'

type Json = Record<string, any>

const emptyVocab = (): Vocabulary => ({
  inboxTagId: 1,
  tags: [{ id: 1, name: 'Inbox', isInboxTag: true, documentCount: 0 }],
  correspondents: [],
})

const output = (o: Json) => JSON.stringify({ proposed_new_correspondent: null, proposed_new_tags: [], ...o })

describe('buildSuggestionSchema', () => {
  it('restricts tags to existing names without the inbox tag', () => {
    const s = buildSuggestionSchema(makeVocabulary()) as Json
    expect(s.properties.tags.items.enum).toEqual(['Rechnung', 'Telefon/Internet', 'Versicherung', 'Müller "Bau"'])
    expect(s.properties.proposed_new_tags.maxItems).toBe(2)
    expect(s.properties.title.maxLength).toBe(TITLE_MAX)
    expect(s.required).toEqual(['title', 'correspondent', 'proposed_new_correspondent', 'tags', 'proposed_new_tags'])
  })

  it('allows an existing correspondent or null', () => {
    const s = buildSuggestionSchema(makeVocabulary()) as Json
    expect(s.properties.correspondent).toEqual({
      anyOf: [
        { type: 'string', enum: ['Deutsche Telekom AG', 'Stadtwerke München GmbH', 'Allianz Versicherung'] },
        { type: 'null' },
      ],
    })
  })

  it('produces a valid schema for an empty vocabulary', () => {
    const s = buildSuggestionSchema(emptyVocab()) as Json
    expect(s.properties.correspondent).toEqual({ type: 'null' })
    expect(s.properties.tags).toEqual({ type: 'array', items: { type: 'string' }, maxItems: 0 })
  })
})

describe('extractJson', () => {
  it('strips reasoning blocks and code fences', () => {
    expect(extractJson('<think>hmm {not json}</think>\n```json\n{"a":1}\n```')).toBe('{"a":1}')
  })

  it('cuts surrounding prose', () => {
    expect(extractJson('Here you go: {"a":1} hope it helps')).toBe('{"a":1}')
  })
})

describe('parseSuggestionOutput', () => {
  const v = makeVocabulary()

  it('accepts valid output', () => {
    const r = parseSuggestionOutput(output({ title: 'Telekom Rechnung', correspondent: 'Deutsche Telekom AG', tags: ['Rechnung'] }), v)
    expect(r).toEqual({
      ok: true,
      value: { title: 'Telekom Rechnung', correspondent: 'Deutsche Telekom AG', proposed_new_correspondent: null, tags: ['Rechnung'], proposed_new_tags: [] },
    })
  })

  it('round-trips names with special characters', () => {
    const r = parseSuggestionOutput(output({ title: 'x', correspondent: null, tags: ['Telefon/Internet', 'Müller "Bau"'] }), v)
    expect(r.ok && r.value.tags).toEqual(['Telefon/Internet', 'Müller "Bau"'])
  })

  it('parses output wrapped in a reasoning block', () => {
    const r = parseSuggestionOutput(`<think>Let me see.</think>${output({ title: 'x', correspondent: null, tags: [] })}`, v)
    expect(r.ok).toBe(true)
  })

  it('defaults missing proposal fields', () => {
    const r = parseSuggestionOutput(JSON.stringify({ title: 'x', correspondent: null, tags: [] }), v)
    expect(r.ok && r.value).toMatchObject({ proposed_new_correspondent: null, proposed_new_tags: [] })
  })

  it('truncates long titles and dedupes tags', () => {
    const r = parseSuggestionOutput(output({ title: 'A'.repeat(100), correspondent: null, tags: ['Rechnung', 'Rechnung'] }), v)
    expect(r.ok && r.value.title).toHaveLength(TITLE_MAX)
    expect(r.ok && r.value.tags).toEqual(['Rechnung'])
  })

  it('rejects unknown tags and correspondents', () => {
    const tag = parseSuggestionOutput(output({ title: 'x', correspondent: null, tags: ['Nope'] }), v)
    expect(tag).toEqual({ ok: false, error: expect.stringContaining('tags.0') })
    const corr = parseSuggestionOutput(output({ title: 'x', correspondent: 'Nope', tags: [] }), v)
    expect(corr).toEqual({ ok: false, error: expect.stringContaining('correspondent') })
  })

  it('rejects the inbox tag', () => {
    expect(parseSuggestionOutput(output({ title: 'x', correspondent: null, tags: ['Inbox'] }), v).ok).toBe(false)
  })

  it('rejects invalid JSON and empty titles', () => {
    expect(parseSuggestionOutput('not json', v)).toEqual({ ok: false, error: expect.stringMatching(/not valid JSON/) })
    expect(parseSuggestionOutput(output({ title: '  ', correspondent: null, tags: [] }), v).ok).toBe(false)
  })

  it('accepts output for an empty vocabulary', () => {
    const r = parseSuggestionOutput(output({ title: 'x', correspondent: null, tags: [], proposed_new_tags: ['Neu'] }), emptyVocab())
    expect(r.ok && r.value.proposed_new_tags).toEqual(['Neu'])
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/suggest/schema.test.ts`
Expected: FAIL, because the module does not exist.

- [ ] **Step 4: Implement `src/suggest/schema.ts`**

```ts
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
  const schema = z.object({
    title: z.string().trim().min(1),
    correspondent: z
      .string()
      .nullable()
      .refine((c) => c === null || correspondentNames.has(c), 'unknown correspondent'),
    proposed_new_correspondent: z.string().trim().min(1).nullable().optional(),
    tags: z.array(z.string().refine((t) => tagNames.has(t), 'unknown tag')),
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/suggest/schema.test.ts && npm run typecheck`
Expected: 14 tests PASS; `tsc` exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/suggest/types.ts src/suggest/schema.ts tests/suggest/schema.test.ts
git commit -m "feat: suggestion JSON schema restricted to existing names" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Prompt building and few-shot examples

**Files:**
- Create: `src/suggest/prompt.ts`, `src/suggest/examples.ts`
- Test: `tests/suggest/prompt.test.ts`, `tests/suggest/examples.test.ts`

**Interfaces:**
- Consumes: `Vocabulary`, `PaperlessCorrespondent`, `PaperlessDocument` (Task 3); `selectableTags` (Task 3); `PaperlessClient` (Task 3); `normalizeName` (Task 2); `Example` (Task 5)
- Produces:
  ```ts
  // prompt.ts
  export const EXAMPLE_CHARS = 800
  export function truncateContent(content: string, maxChars: number): string
  export function guessCorrespondent(content: string, correspondents: PaperlessCorrespondent[]): PaperlessCorrespondent | null
  export function buildPrompt(input: { content: string; vocabulary: Vocabulary; examples: Example[] }): { system: string; user: string }
  // examples.ts
  export const EXAMPLE_COUNT = 3
  export function toExample(doc: PaperlessDocument, v: Vocabulary): Example
  export function loadExamples(client: Pick<PaperlessClient, 'listFiledDocuments'>, v: Vocabulary, content: string, exclude: ReadonlySet<number>): Promise<Example[]>
  ```

- [ ] **Step 1: Write the failing test `tests/suggest/prompt.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { buildPrompt, guessCorrespondent, truncateContent } from '../../src/suggest/prompt'
import { makeVocabulary } from '../helpers/fixtures'

describe('truncateContent', () => {
  it('trims and keeps short content', () => {
    expect(truncateContent('  abc  ', 10)).toBe('abc')
  })

  it('cuts long content and marks the cut', () => {
    expect(truncateContent('abcdef', 3)).toBe('abc\n[…]')
  })
})

describe('guessCorrespondent', () => {
  const { correspondents } = makeVocabulary()

  it('finds a correspondent named in the text, ignoring case, umlauts and legal suffix', () => {
    expect(guessCorrespondent('Ihre Stadtwerke Muenchen informieren', correspondents)?.id).toBe(11)
    expect(guessCorrespondent('DEUTSCHE TELEKOM AG, Bonn', correspondents)?.id).toBe(10)
  })

  it('prefers the longest match', () => {
    const cs = [
      { id: 1, name: 'Allianz', documentCount: 1 },
      { id: 2, name: 'Allianz Versicherung', documentCount: 1 },
    ]
    expect(guessCorrespondent('Allianz Versicherung AG', cs)?.id).toBe(2)
  })

  it('returns null when nothing matches or names are too short', () => {
    expect(guessCorrespondent('Hallo Welt', correspondents)).toBeNull()
    expect(guessCorrespondent('ab cd', [{ id: 1, name: 'AB', documentCount: 0 }])).toBeNull()
  })
})

describe('buildPrompt', () => {
  const vocabulary = makeVocabulary()

  it('lists correspondents and tags with counts, most used first, without the inbox tag', () => {
    const { system } = buildPrompt({ content: 'x', vocabulary, examples: [] })
    expect(system).toContain('- Deutsche Telekom AG')
    expect(system).toContain('- Rechnung (120)')
    expect(system.indexOf('Rechnung (120)')).toBeLessThan(system.indexOf('Versicherung (30)'))
    expect(system).not.toContain('Inbox')
    expect(system).toMatch(/propose a new one only if/i)
  })

  it('says (none) for an empty vocabulary', () => {
    const { system } = buildPrompt({
      content: 'x',
      vocabulary: { inboxTagId: 1, tags: [], correspondents: [] },
      examples: [],
    })
    expect(system.match(/\(none\)/g)).toHaveLength(2)
  })

  it('includes truncated examples and the document', () => {
    const { user } = buildPrompt({
      content: 'THE DOCUMENT',
      vocabulary,
      examples: [{ title: 'Alte Rechnung', correspondent: 'Deutsche Telekom AG', tags: ['Rechnung'], content: 'E'.repeat(2000) }],
    })
    expect(user).toContain('### Example 1')
    expect(user).toContain('Filed as: {"title":"Alte Rechnung","correspondent":"Deutsche Telekom AG","tags":["Rechnung"]}')
    expect(user).not.toContain('E'.repeat(801))
    expect(user).toContain('### Document to file')
    expect(user.trimEnd().endsWith('THE DOCUMENT\n"""')).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/suggest/prompt.test.ts`
Expected: FAIL, because the module does not exist.

- [ ] **Step 3: Implement `src/suggest/prompt.ts`**

```ts
import { selectableTags } from '../paperless/vocabulary'
import type { PaperlessCorrespondent, Vocabulary } from '../paperless/types'
import { normalizeName } from './normalize'
import type { Example } from './types'

export const EXAMPLE_CHARS = 800

const RULES = `You file scanned documents in a Paperless-ngx archive. For the document you are given, suggest a title, a correspondent and tags.

Rules:
- Correspondent: the sender or issuer of the document. Pick one from the list of existing correspondents. Use null only if none of them fits; then put a new name in proposed_new_correspondent.
- Tags: pick all fitting tags from the list of existing tags. Prefer tags that are used often. Use existing tags and correspondents; propose a new one only if nothing in the list fits at all, and never propose a name that means the same as an existing one. At most 2 new tags.
- Title: in the language of the document, at most 80 characters, shaped like "<Correspondent> <document type> <subject or period>", for example "Telekom Rechnung Mobilfunk September 2026". Only use dates that appear in the document.
- Answer with JSON only.`

export function truncateContent(content: string, maxChars: number): string {
  const t = content.trim()
  return t.length <= maxChars ? t : `${t.slice(0, maxChars)}\n[…]`
}

export function guessCorrespondent(
  content: string,
  correspondents: PaperlessCorrespondent[],
): PaperlessCorrespondent | null {
  const haystack = ` ${normalizeName(content)} `
  let best: { c: PaperlessCorrespondent; length: number } | null = null
  for (const c of correspondents) {
    const needle = normalizeName(c.name)
    if (needle.length < 3) continue
    if (haystack.includes(` ${needle} `) && (!best || needle.length > best.length)) {
      best = { c, length: needle.length }
    }
  }
  return best?.c ?? null
}

export function buildPrompt(input: {
  content: string
  vocabulary: Vocabulary
  examples: Example[]
}): { system: string; user: string } {
  const tags = selectableTags(input.vocabulary).sort(
    (a, b) => b.documentCount - a.documentCount || a.name.localeCompare(b.name),
  )
  const correspondents = [...input.vocabulary.correspondents].sort((a, b) => a.name.localeCompare(b.name))
  const system = [
    RULES,
    '',
    'Existing correspondents:',
    ...(correspondents.length > 0 ? correspondents.map((c) => `- ${c.name}`) : ['(none)']),
    '',
    'Existing tags (number of documents using the tag):',
    ...(tags.length > 0 ? tags.map((t) => `- ${t.name} (${t.documentCount})`) : ['(none)']),
  ].join('\n')

  const parts: string[] = []
  if (input.examples.length > 0) {
    parts.push('Examples of documents that were already filed:')
    input.examples.forEach((ex, i) => {
      parts.push(
        '',
        `### Example ${i + 1}`,
        'Text:',
        '"""',
        truncateContent(ex.content, EXAMPLE_CHARS),
        '"""',
        `Filed as: ${JSON.stringify({ title: ex.title, correspondent: ex.correspondent, tags: ex.tags })}`,
      )
    })
    parts.push('')
  }
  parts.push('### Document to file', 'Text:', '"""', input.content, '"""')
  return { system, user: parts.join('\n') }
}
```

- [ ] **Step 4: Run the prompt test to verify it passes**

Run: `npx vitest run tests/suggest/prompt.test.ts`
Expected: 8 tests PASS.

- [ ] **Step 5: Write the failing test `tests/suggest/examples.test.ts`**

```ts
import { describe, expect, it, vi } from 'vitest'
import { loadExamples, toExample } from '../../src/suggest/examples'
import { makeDocument, makeVocabulary } from '../helpers/fixtures'

const v = makeVocabulary()
const filed = (id: number, correspondent: number | null = 10) =>
  makeDocument({ id, title: `Filed ${id}`, correspondent, tags: [2, 3], content: `content ${id}` })

describe('toExample', () => {
  it('resolves names and drops the inbox tag', () => {
    expect(toExample(makeDocument({ correspondent: 10, tags: [1, 2] }), v)).toMatchObject({
      title: 'scan_0001',
      correspondent: 'Deutsche Telekom AG',
      tags: ['Rechnung'],
    })
  })
})

describe('loadExamples', () => {
  it('uses documents of the correspondent named in the text', async () => {
    const listFiledDocuments = vi.fn(async () => [filed(1), filed(2), filed(3), filed(4)])
    const examples = await loadExamples({ listFiledDocuments }, v, 'Deutsche Telekom AG Rechnung', new Set())
    expect(listFiledDocuments).toHaveBeenCalledWith({ inboxTagId: 1, correspondentId: 10, limit: 3 })
    expect(examples.map((e) => e.title)).toEqual(['Filed 1', 'Filed 2', 'Filed 3'])
    expect(examples[0]!.tags).toEqual(['Rechnung', 'Telefon/Internet'])
  })

  it('falls back to recent documents when no correspondent is recognised', async () => {
    const listFiledDocuments = vi.fn(async () => [filed(7, 11)])
    await loadExamples({ listFiledDocuments }, v, 'unknown sender', new Set())
    expect(listFiledDocuments).toHaveBeenCalledWith({ inboxTagId: 1, limit: 3 })
  })

  it('excludes given ids and falls back when all matches are excluded', async () => {
    const listFiledDocuments = vi
      .fn()
      .mockResolvedValueOnce([filed(1)])
      .mockResolvedValueOnce([filed(1), filed(8, 11)])
    const examples = await loadExamples({ listFiledDocuments }, v, 'Deutsche Telekom AG', new Set([1]))
    expect(listFiledDocuments).toHaveBeenNthCalledWith(1, { inboxTagId: 1, correspondentId: 10, limit: 4 })
    expect(listFiledDocuments).toHaveBeenNthCalledWith(2, { inboxTagId: 1, limit: 4 })
    expect(examples.map((e) => e.title)).toEqual(['Filed 8'])
  })
})
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run tests/suggest/examples.test.ts`
Expected: FAIL, because the module does not exist.

- [ ] **Step 7: Implement `src/suggest/examples.ts`**

```ts
import type { PaperlessClient } from '../paperless/client'
import type { PaperlessDocument, Vocabulary } from '../paperless/types'
import { guessCorrespondent } from './prompt'
import type { Example } from './types'

export const EXAMPLE_COUNT = 3
const MAX_FETCH = 100

export function toExample(doc: PaperlessDocument, v: Vocabulary): Example {
  const tagNames = new Map(v.tags.map((t) => [t.id, t.name]))
  const correspondentNames = new Map(v.correspondents.map((c) => [c.id, c.name]))
  return {
    title: doc.title,
    correspondent: doc.correspondent === null ? null : (correspondentNames.get(doc.correspondent) ?? null),
    tags: doc.tags
      .filter((id) => id !== v.inboxTagId)
      .map((id) => tagNames.get(id))
      .filter((n): n is string => n !== undefined),
    content: doc.content,
  }
}

/** Filed documents (not in the inbox) used as few-shot examples; ids in `exclude` are never used. */
export async function loadExamples(
  client: Pick<PaperlessClient, 'listFiledDocuments'>,
  v: Vocabulary,
  content: string,
  exclude: ReadonlySet<number>,
): Promise<Example[]> {
  const limit = Math.min(EXAMPLE_COUNT + exclude.size, MAX_FETCH)
  const guess = guessCorrespondent(content, v.correspondents)
  let docs: PaperlessDocument[] = []
  if (guess) {
    docs = (await client.listFiledDocuments({ inboxTagId: v.inboxTagId, correspondentId: guess.id, limit })).filter(
      (d) => !exclude.has(d.id),
    )
  }
  if (docs.length === 0) {
    docs = (await client.listFiledDocuments({ inboxTagId: v.inboxTagId, limit })).filter((d) => !exclude.has(d.id))
  }
  return docs.slice(0, EXAMPLE_COUNT).map((d) => toExample(d, v))
}
```

- [ ] **Step 8: Run tests and typecheck**

Run: `npx vitest run tests/suggest && npm run typecheck`
Expected: all PASS; `tsc` exits 0.

- [ ] **Step 9: Commit**

```bash
git add src/suggest/prompt.ts src/suggest/examples.ts tests/suggest/prompt.test.ts tests/suggest/examples.test.ts
git commit -m "feat: prompt builder and few-shot example selection" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Suggester

**Files:**
- Create: `src/suggest/suggester.ts`
- Test: `tests/suggest/suggester.test.ts`

**Interfaces:**
- Consumes: `LlmClient`, `LlmError` (Task 4); `buildSuggestionSchema`, `parseSuggestionOutput` (Task 5); `buildPrompt`, `truncateContent` (Task 6); `rankMatches`, `normalizeName` (Task 2); `selectableTags` (Task 3); types from Task 5
- Produces:
  ```ts
  export const SCHEMA_NAME = 'document_suggestion'
  export interface SuggesterOptions { llm: LlmClient; maxContentChars: number; matchThreshold: number }
  export function createSuggester(opts: SuggesterOptions): Suggester
  export function resolveSuggestion(raw: RawSuggestion, v: Vocabulary, model: string, threshold: number): Suggestion
  ```

- [ ] **Step 1: Write the failing test `tests/suggest/suggester.test.ts`**

```ts
import { describe, expect, it, vi } from 'vitest'
import { LlmError, type LlmClient, type LlmRequest } from '../../src/llm/client'
import { createSuggester } from '../../src/suggest/suggester'
import type { Vocabulary } from '../../src/paperless/types'
import { makeVocabulary } from '../helpers/fixtures'

function fakeLlm(...contents: string[]) {
  const requests: LlmRequest[] = []
  const llm: LlmClient = {
    health: vi.fn(),
    complete: vi.fn(async (req: LlmRequest) => {
      requests.push(req)
      const content = contents.shift()
      if (content === undefined) throw new Error('no more fake responses')
      return { content, model: req.model ?? 'fake-model' }
    }),
  }
  return { llm, requests }
}

const out = (o: Record<string, unknown>) =>
  JSON.stringify({ title: 'Telekom Rechnung', correspondent: null, proposed_new_correspondent: null, tags: [], proposed_new_tags: [], ...o })

const input = (content = 'Deutsche Telekom AG Rechnung', vocabulary: Vocabulary = makeVocabulary()) => ({
  content,
  vocabulary,
  examples: [],
})

const make = (llm: LlmClient) => createSuggester({ llm, maxContentChars: 6000, matchThreshold: 0.85 })

describe('Suggester', () => {
  it('returns no_text without calling the LLM for empty content', async () => {
    const { llm } = fakeLlm()
    expect(await make(llm).suggest(input('   \n '))).toEqual({ kind: 'no_text' })
    expect(llm.complete).not.toHaveBeenCalled()
  })

  it('resolves names to ids', async () => {
    const { llm, requests } = fakeLlm(out({ correspondent: 'Deutsche Telekom AG', tags: ['Rechnung', 'Telefon/Internet'] }))
    const r = await make(llm).suggest(input())
    expect(r).toEqual({
      kind: 'ok',
      suggestion: {
        title: 'Telekom Rechnung',
        correspondentId: 10,
        proposedCorrespondent: null,
        tagIds: [2, 3],
        proposedTags: [],
        matchedNotes: {},
        model: 'fake-model',
      },
    })
    expect(requests[0]!.schemaName).toBe('document_suggestion')
    expect(requests[0]!.user).toContain('Deutsche Telekom AG Rechnung')
  })

  it('retries once on invalid output', async () => {
    const { llm } = fakeLlm('garbage', out({ tags: ['Rechnung'] }))
    const r = await make(llm).suggest(input())
    expect(r.kind).toBe('ok')
    expect(llm.complete).toHaveBeenCalledTimes(2)
  })

  it('returns an error after two invalid outputs', async () => {
    const { llm } = fakeLlm(out({ tags: ['Nope'] }), out({ tags: ['Nope'] }))
    const r = await make(llm).suggest(input())
    expect(r).toEqual({ kind: 'error', error: expect.stringContaining('unknown tag'), model: 'fake-model' })
  })

  it('propagates LLM transport errors', async () => {
    const llm: LlmClient = { health: vi.fn(), complete: vi.fn(async () => { throw new LlmError('down') }) }
    await expect(make(llm).suggest(input())).rejects.toBeInstanceOf(LlmError)
  })

  it('auto-maps a proposed correspondent that matches an existing one', async () => {
    const { llm } = fakeLlm(out({ proposed_new_correspondent: 'Telekom' }))
    const r = await make(llm).suggest(input())
    expect(r.kind === 'ok' && r.suggestion).toMatchObject({
      correspondentId: 10,
      proposedCorrespondent: null,
      matchedNotes: { Telekom: 'Deutsche Telekom AG' },
    })
  })

  it('keeps a genuinely new tag as proposal with nearest names', async () => {
    const { llm } = fakeLlm(out({ tags: ['Rechnung'], proposed_new_tags: ['Mobilfunk'] }))
    const r = await make(llm).suggest(input())
    expect(r.kind === 'ok' && r.suggestion.proposedTags).toEqual([
      { name: 'Mobilfunk', nearest: expect.any(Array) },
    ])
  })

  it('maps a near-duplicate tag without duplicating it', async () => {
    const { llm } = fakeLlm(out({ tags: ['Rechnung'], proposed_new_tags: ['Rechnungen'] }))
    const r = await make(llm).suggest(input())
    expect(r.kind === 'ok' && r.suggestion).toMatchObject({ tagIds: [2], proposedTags: [], matchedNotes: {} })
  })

  it('works with an empty vocabulary, turning everything into proposals', async () => {
    const empty: Vocabulary = { inboxTagId: 1, tags: [{ id: 1, name: 'Inbox', isInboxTag: true, documentCount: 0 }], correspondents: [] }
    const { llm } = fakeLlm(out({ proposed_new_correspondent: 'Telekom', proposed_new_tags: ['Rechnung'] }))
    const r = await make(llm).suggest(input('Telekom Rechnung', empty))
    expect(r.kind === 'ok' && r.suggestion).toMatchObject({
      correspondentId: null,
      proposedCorrespondent: { name: 'Telekom', nearest: [] },
      tagIds: [],
      proposedTags: [{ name: 'Rechnung', nearest: [] }],
    })
  })

  it('passes the model override and truncates content', async () => {
    const { llm, requests } = fakeLlm(out({}))
    const s = createSuggester({ llm, maxContentChars: 10, matchThreshold: 0.85 })
    await s.suggest({ ...input('0123456789ABCDEF'), model: 'gemma' })
    expect(requests[0]!.model).toBe('gemma')
    expect(requests[0]!.user).toContain('0123456789\n[…]')
    expect(requests[0]!.user).not.toContain('ABCDEF')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/suggest/suggester.test.ts`
Expected: FAIL, because the module does not exist.

- [ ] **Step 3: Implement `src/suggest/suggester.ts`**

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/suggest && npm run typecheck`
Expected: all PASS; `tsc` exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/suggest/suggester.ts tests/suggest/suggester.test.ts
git commit -m "feat: suggester with retry and new-name auto-mapping" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: SQLite suggestion store

**Files:**
- Create: `src/store/db.ts`, `src/store/suggestions.ts`
- Test: `tests/store/suggestions.test.ts`

**Interfaces:**
- Consumes: `SuggestResult`, `Proposal` (Task 5)
- Produces:
  ```ts
  // db.ts
  export type Db = Database.Database
  export function openDb(file: string): Db   // ':memory:' for tests; runs migrations
  // suggestions.ts
  export type SuggestionStatus = 'pending' | 'ready' | 'applied' | 'error' | 'no_text'
  export interface StoredSuggestion { documentId: number; status: SuggestionStatus; title: string | null; correspondentId: number | null; proposedCorrespondent: Proposal | null; tagIds: number[]; proposedTags: Proposal[]; matchedNotes: Record<string, string>; model: string | null; error: string | null; docModified: string | null; updatedAt: string }
  export interface InboxItem { documentId: number; added: string; contentHash: string }
  export interface ResultMeta { contentHash: string; vocabHash: string; docModified: string }
  export interface StatusCounts { ready: number; pending: number; error: number; noText: number }
  export class SuggestionStore {
    constructor(db: Db, now?: () => Date)
    syncInbox(items: InboxItem[], vocabHash: string): void
    nextWork(): number | null
    saveResult(documentId: number, result: SuggestResult, meta: ResultMeta): void
    get(documentId: number): StoredSuggestion | null
    nextReviewable(afterId?: number): number | null
    requestRegenerate(documentId: number): boolean
    markApplied(documentId: number): void
    counts(): StatusCounts
    getMeta(key: string): string | null
    setMeta(key: string, value: string): void
  }
  ```

- [ ] **Step 1: Write the failing test `tests/store/suggestions.test.ts`**

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../../src/store/db'
import { SuggestionStore } from '../../src/store/suggestions'
import type { SuggestResult } from '../../src/suggest/types'

const ok: SuggestResult = {
  kind: 'ok',
  suggestion: {
    title: 'Telekom Rechnung',
    correspondentId: 10,
    proposedCorrespondent: null,
    tagIds: [2],
    proposedTags: [{ name: 'Mobilfunk', nearest: [{ id: 3, name: 'Telefon/Internet', score: 0.3 }] }],
    matchedNotes: { Telekom: 'Deutsche Telekom AG' },
    model: 'qwen3-14b',
  },
}
const meta = (contentHash = 'c1', vocabHash = 'v1') => ({ contentHash, vocabHash, docModified: 'm1' })
const item = (documentId: number, added: string, contentHash = 'c1') => ({ documentId, added, contentHash })

let store: SuggestionStore
let clock: number

beforeEach(() => {
  clock = Date.parse('2026-09-29T10:00:00Z')
  store = new SuggestionStore(openDb(':memory:'), () => new Date(clock))
})

describe('SuggestionStore', () => {
  it('adds new inbox documents as pending and hands out work oldest first', () => {
    store.syncInbox([item(2, '2026-09-02'), item(1, '2026-09-01')], 'v1')
    expect(store.get(1)?.status).toBe('pending')
    expect(store.nextWork()).toBe(1)
    expect(store.counts()).toEqual({ ready: 0, pending: 2, error: 0, noText: 0 })
  })

  it('stores and returns a suggestion', () => {
    store.syncInbox([item(1, '2026-09-01')], 'v1')
    store.saveResult(1, ok, meta())
    expect(store.get(1)).toEqual({
      documentId: 1,
      status: 'ready',
      title: 'Telekom Rechnung',
      correspondentId: 10,
      proposedCorrespondent: null,
      tagIds: [2],
      proposedTags: [{ name: 'Mobilfunk', nearest: [{ id: 3, name: 'Telefon/Internet', score: 0.3 }] }],
      matchedNotes: { Telekom: 'Deutsche Telekom AG' },
      model: 'qwen3-14b',
      error: null,
      docModified: 'm1',
      updatedAt: '2026-09-29T10:00:00.000Z',
    })
    expect(store.nextWork()).toBeNull()
  })

  it('stores errors and no_text results', () => {
    store.syncInbox([item(1, 'a'), item(2, 'b')], 'v1')
    store.saveResult(1, { kind: 'error', error: 'bad output', model: 'm' }, meta())
    store.saveResult(2, { kind: 'no_text' }, meta())
    expect(store.get(1)).toMatchObject({ status: 'error', error: 'bad output', model: 'm', title: null })
    expect(store.get(2)).toMatchObject({ status: 'no_text', error: null })
    expect(store.counts()).toEqual({ ready: 0, pending: 0, error: 1, noText: 1 })
  })

  it('marks suggestions stale when content or vocabulary changes', () => {
    store.syncInbox([item(1, 'a'), item(2, 'b')], 'v1')
    store.saveResult(1, ok, meta('c1', 'v1'))
    store.saveResult(2, ok, meta('c1', 'v1'))
    store.syncInbox([item(1, 'a', 'c2'), item(2, 'b')], 'v1')
    expect(store.get(1)?.status).toBe('pending')
    expect(store.get(2)?.status).toBe('ready')
    store.syncInbox([item(1, 'a', 'c2'), item(2, 'b')], 'v2')
    expect(store.get(2)?.status).toBe('pending')
  })

  it('does not touch updatedAt when a poll changes nothing', () => {
    store.syncInbox([item(1, 'a')], 'v1')
    store.saveResult(1, ok, meta())
    clock += 60_000
    store.syncInbox([item(1, 'a')], 'v1')
    expect(store.get(1)?.updatedAt).toBe('2026-09-29T10:00:00.000Z')
  })

  it('drops documents that left the inbox from queue and counts', () => {
    store.syncInbox([item(1, 'a'), item(2, 'b')], 'v1')
    store.saveResult(1, ok, meta())
    store.syncInbox([item(2, 'b')], 'v1')
    expect(store.nextReviewable()).toBeNull()
    expect(store.counts().ready).toBe(0)
    expect(store.get(1)?.status).toBe('ready')
  })

  it('resets an applied document that is back in the inbox', () => {
    store.syncInbox([item(1, 'a')], 'v1')
    store.saveResult(1, ok, meta())
    store.markApplied(1)
    store.syncInbox([], 'v1')
    store.syncInbox([item(1, 'a')], 'v1')
    expect(store.get(1)?.status).toBe('pending')
  })

  it('walks reviewable documents in inbox order', () => {
    store.syncInbox([item(3, '2026-09-03'), item(1, '2026-09-01'), item(2, '2026-09-01')], 'v1')
    store.saveResult(1, ok, meta())
    store.saveResult(2, { kind: 'error', error: 'x', model: null }, meta())
    store.saveResult(3, { kind: 'no_text' }, meta())
    expect(store.nextReviewable()).toBe(1)
    expect(store.nextReviewable(1)).toBe(2)
    expect(store.nextReviewable(2)).toBe(3)
    expect(store.nextReviewable(3)).toBeNull()
    store.markApplied(1)
    expect(store.nextReviewable()).toBe(2)
    expect(store.nextReviewable(1)).toBe(2)
    expect(store.nextReviewable(999)).toBe(2)
  })

  it('prioritises regeneration requests', () => {
    store.syncInbox([item(1, 'a'), item(2, 'b')], 'v1')
    store.saveResult(2, ok, meta())
    expect(store.requestRegenerate(2)).toBe(true)
    expect(store.get(2)?.status).toBe('pending')
    expect(store.nextWork()).toBe(2)
    store.saveResult(2, ok, meta())
    expect(store.nextWork()).toBe(1)
  })

  it('refuses to regenerate unknown or applied documents', () => {
    store.syncInbox([item(1, 'a')], 'v1')
    store.markApplied(1)
    expect(store.requestRegenerate(1)).toBe(false)
    expect(store.requestRegenerate(42)).toBe(false)
  })

  it('stores meta values', () => {
    expect(store.getMeta('k')).toBeNull()
    store.setMeta('k', 'v')
    store.setMeta('k', 'w')
    expect(store.getMeta('k')).toBe('w')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/store/suggestions.test.ts`
Expected: FAIL, because the modules do not exist.

- [ ] **Step 3: Implement `src/store/db.ts`**

```ts
import Database from 'better-sqlite3'

export type Db = Database.Database

export function openDb(file: string): Db {
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS suggestions (
      document_id INTEGER PRIMARY KEY,
      status TEXT NOT NULL,
      in_inbox INTEGER NOT NULL DEFAULT 1,
      added TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      title TEXT,
      correspondent_id INTEGER,
      proposed_correspondent TEXT,
      tag_ids TEXT NOT NULL DEFAULT '[]',
      proposed_tags TEXT NOT NULL DEFAULT '[]',
      matched_notes TEXT NOT NULL DEFAULT '{}',
      model TEXT,
      content_hash TEXT,
      vocab_hash TEXT,
      doc_modified TEXT,
      error TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS suggestions_queue ON suggestions (in_inbox, status, added, document_id);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `)
  return db
}
```

- [ ] **Step 4: Implement `src/store/suggestions.ts`**

```ts
import type { Proposal, SuggestResult } from '../suggest/types'
import type { Db } from './db'

export type SuggestionStatus = 'pending' | 'ready' | 'applied' | 'error' | 'no_text'

export interface StoredSuggestion {
  documentId: number
  status: SuggestionStatus
  title: string | null
  correspondentId: number | null
  proposedCorrespondent: Proposal | null
  tagIds: number[]
  proposedTags: Proposal[]
  matchedNotes: Record<string, string>
  model: string | null
  error: string | null
  docModified: string | null
  /** Changes only when the suggestion or its status changes. */
  updatedAt: string
}

export interface InboxItem {
  documentId: number
  added: string
  contentHash: string
}

export interface ResultMeta {
  contentHash: string
  vocabHash: string
  docModified: string
}

export interface StatusCounts {
  ready: number
  pending: number
  error: number
  noText: number
}

interface Row {
  document_id: number
  status: SuggestionStatus
  added: string
  title: string | null
  correspondent_id: number | null
  proposed_correspondent: string | null
  tag_ids: string
  proposed_tags: string
  matched_notes: string
  model: string | null
  content_hash: string | null
  vocab_hash: string | null
  doc_modified: string | null
  error: string | null
  updated_at: string
}

const REVIEWABLE = `in_inbox = 1 AND status IN ('ready', 'error', 'no_text')`
const REFRESHABLE: SuggestionStatus[] = ['ready', 'error', 'no_text']

export class SuggestionStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private ts(): string {
    return this.now().toISOString()
  }

  syncInbox(items: InboxItem[], vocabHash: string): void {
    const find = this.db.prepare('SELECT status, content_hash, vocab_hash FROM suggestions WHERE document_id = ?')
    const insert = this.db.prepare(
      `INSERT INTO suggestions (document_id, status, in_inbox, added, created_at, updated_at)
       VALUES (@id, 'pending', 1, @added, @now, @now)`,
    )
    const keep = this.db.prepare('UPDATE suggestions SET in_inbox = 1, added = @added WHERE document_id = @id')
    const reset = this.db.prepare(
      `UPDATE suggestions SET in_inbox = 1, added = @added, status = 'pending', updated_at = @now WHERE document_id = @id`,
    )
    this.db.transaction(() => {
      this.db.prepare('UPDATE suggestions SET in_inbox = 0').run()
      const now = this.ts()
      for (const it of items) {
        const row = find.get(it.documentId) as Pick<Row, 'status' | 'content_hash' | 'vocab_hash'> | undefined
        const params = { id: it.documentId, added: it.added }
        if (!row) {
          insert.run({ ...params, now })
          continue
        }
        const stale =
          row.status === 'applied' ||
          (REFRESHABLE.includes(row.status) && (row.content_hash !== it.contentHash || row.vocab_hash !== vocabHash))
        if (stale) reset.run({ ...params, now })
        else keep.run(params)
      }
    })()
  }

  nextWork(): number | null {
    const row = this.db
      .prepare(
        `SELECT document_id FROM suggestions WHERE in_inbox = 1 AND status = 'pending'
         ORDER BY priority DESC, added ASC, document_id ASC LIMIT 1`,
      )
      .get() as { document_id: number } | undefined
    return row?.document_id ?? null
  }

  saveResult(documentId: number, result: SuggestResult, meta: ResultMeta): void {
    const s = result.kind === 'ok' ? result.suggestion : null
    this.db
      .prepare(
        `UPDATE suggestions SET
           status = @status, title = @title, correspondent_id = @correspondentId,
           proposed_correspondent = @proposedCorrespondent, tag_ids = @tagIds, proposed_tags = @proposedTags,
           matched_notes = @matchedNotes, model = @model, error = @error,
           content_hash = @contentHash, vocab_hash = @vocabHash, doc_modified = @docModified,
           attempts = attempts + 1, priority = 0, updated_at = @now
         WHERE document_id = @documentId`,
      )
      .run({
        documentId,
        status: result.kind === 'ok' ? 'ready' : result.kind,
        title: s?.title ?? null,
        correspondentId: s?.correspondentId ?? null,
        proposedCorrespondent: s?.proposedCorrespondent ? JSON.stringify(s.proposedCorrespondent) : null,
        tagIds: JSON.stringify(s?.tagIds ?? []),
        proposedTags: JSON.stringify(s?.proposedTags ?? []),
        matchedNotes: JSON.stringify(s?.matchedNotes ?? {}),
        model: s?.model ?? (result.kind === 'error' ? result.model : null),
        error: result.kind === 'error' ? result.error : null,
        contentHash: meta.contentHash,
        vocabHash: meta.vocabHash,
        docModified: meta.docModified,
        now: this.ts(),
      })
  }

  get(documentId: number): StoredSuggestion | null {
    const r = this.db.prepare('SELECT * FROM suggestions WHERE document_id = ?').get(documentId) as Row | undefined
    if (!r) return null
    return {
      documentId: r.document_id,
      status: r.status,
      title: r.title,
      correspondentId: r.correspondent_id,
      proposedCorrespondent: r.proposed_correspondent ? (JSON.parse(r.proposed_correspondent) as Proposal) : null,
      tagIds: JSON.parse(r.tag_ids) as number[],
      proposedTags: JSON.parse(r.proposed_tags) as Proposal[],
      matchedNotes: JSON.parse(r.matched_notes) as Record<string, string>,
      model: r.model,
      error: r.error,
      docModified: r.doc_modified,
      updatedAt: r.updated_at,
    }
  }

  nextReviewable(afterId?: number): number | null {
    const ref =
      afterId === undefined
        ? undefined
        : (this.db.prepare('SELECT added FROM suggestions WHERE document_id = ?').get(afterId) as
            | { added: string }
            | undefined)
    const row = (
      ref
        ? this.db
            .prepare(
              `SELECT document_id FROM suggestions WHERE ${REVIEWABLE}
               AND (added > @added OR (added = @added AND document_id > @id))
               ORDER BY added, document_id LIMIT 1`,
            )
            .get({ added: ref.added, id: afterId })
        : this.db.prepare(`SELECT document_id FROM suggestions WHERE ${REVIEWABLE} ORDER BY added, document_id LIMIT 1`).get()
    ) as { document_id: number } | undefined
    return row?.document_id ?? null
  }

  requestRegenerate(documentId: number): boolean {
    const r = this.db
      .prepare(
        `UPDATE suggestions SET status = 'pending', priority = 1, updated_at = ?
         WHERE document_id = ? AND in_inbox = 1 AND status != 'applied'`,
      )
      .run(this.ts(), documentId)
    return r.changes > 0
  }

  markApplied(documentId: number): void {
    this.db
      .prepare(`UPDATE suggestions SET status = 'applied', priority = 0, updated_at = ? WHERE document_id = ?`)
      .run(this.ts(), documentId)
  }

  counts(): StatusCounts {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS n FROM suggestions WHERE in_inbox = 1 GROUP BY status')
      .all() as { status: SuggestionStatus; n: number }[]
    const by = Object.fromEntries(rows.map((r) => [r.status, r.n])) as Partial<Record<SuggestionStatus, number>>
    return { ready: by.ready ?? 0, pending: by.pending ?? 0, error: by.error ?? 0, noText: by.no_text ?? 0 }
  }

  getMeta(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
    return r?.value ?? null
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value)
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/store && npm run typecheck`
Expected: 11 tests PASS; `tsc` exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/store tests/store
git commit -m "feat: SQLite suggestion store with staleness and queue order" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 9: Background worker

**Files:**
- Create: `src/worker/worker.ts`
- Create: `tests/helpers/fakes.ts`
- Test: `tests/worker/worker.test.ts`

**Interfaces:**
- Consumes: `PaperlessClient` (Task 3); `loadVocabulary`, `hashVocabulary` (Task 3); `LlmClient`, `LlmError` (Task 4); `Suggester`, `SuggestResult` (Task 5); `loadExamples` (Task 6); `SuggestionStore` (Task 8)
- Produces:
  ```ts
  export const BACKOFF_START_MS = 60_000
  export const BACKOFF_MAX_MS = 600_000
  export interface WorkerStatus { paperless: { ok: boolean; error: string | null }; llm: { ok: boolean; model: string | null; error: string | null }; lastPollAt: string | null }
  export interface WorkerDeps { paperless: PaperlessClient; llm: LlmClient; suggester: Suggester; store: SuggestionStore; inboxTag: string | null; pollIntervalSec: number; logger?: Pick<Console, 'info' | 'warn' | 'error'>; now?: () => Date }
  export function hashContent(content: string): string
  export class Worker {
    constructor(deps: WorkerDeps)
    status(): WorkerStatus
    tick(): Promise<void>       // one poll + process all pending work; never throws
    nextDelayMs(): number       // poll interval, or LLM backoff while LLM is down
    start(): void
    stop(): void
    wake(): void                // run a tick as soon as possible (after the current one)
  }
  // tests/helpers/fakes.ts
  export const silentLogger: Pick<Console, 'info' | 'warn' | 'error'>
  export function fakePaperless(overrides?: Partial<PaperlessClient>): PaperlessClient
  ```

- [ ] **Step 1: Create `tests/helpers/fakes.ts`**

```ts
import type { PaperlessClient } from '../../src/paperless/client'

export const silentLogger = { info: () => {}, warn: () => {}, error: () => {} }

/** A PaperlessClient whose methods throw unless overridden. */
export function fakePaperless(overrides: Partial<PaperlessClient> = {}): PaperlessClient {
  const missing = (name: string) => async (): Promise<never> => {
    throw new Error(`fakePaperless.${name} was not stubbed`)
  }
  return {
    listInboxDocuments: missing('listInboxDocuments'),
    getDocument: missing('getDocument'),
    listTags: missing('listTags'),
    listCorrespondents: missing('listCorrespondents'),
    listFiledDocuments: missing('listFiledDocuments'),
    createTag: missing('createTag'),
    createCorrespondent: missing('createCorrespondent'),
    updateDocument: missing('updateDocument'),
    fetchFile: missing('fetchFile'),
    ...overrides,
  }
}
```

- [ ] **Step 2: Write the failing test `tests/worker/worker.test.ts`**

```ts
import { describe, expect, it, vi } from 'vitest'
import { LlmError, type LlmClient, type LlmHealth } from '../../src/llm/client'
import { PaperlessError } from '../../src/paperless/client'
import type { PaperlessDocument } from '../../src/paperless/types'
import { openDb } from '../../src/store/db'
import { SuggestionStore } from '../../src/store/suggestions'
import type { SuggestInput, SuggestResult } from '../../src/suggest/types'
import { BACKOFF_MAX_MS, Worker } from '../../src/worker/worker'
import { fakePaperless, silentLogger } from '../helpers/fakes'
import { makeDocument, makeVocabulary } from '../helpers/fixtures'

const okResult: SuggestResult = {
  kind: 'ok',
  suggestion: { title: 'T', correspondentId: 10, proposedCorrespondent: null, tagIds: [2], proposedTags: [], matchedNotes: {}, model: 'm' },
}
const online: LlmHealth = { ok: true, model: 'm' }
const offline: LlmHealth = { ok: false, error: 'LM Studio unreachable: connect ECONNREFUSED' }

function setup(healthSequence: LlmHealth[] = [online]) {
  const store = new SuggestionStore(openDb(':memory:'))
  const v = makeVocabulary()
  let docs: PaperlessDocument[] = [
    makeDocument({ id: 1, added: '2026-09-01', content: 'first' }),
    makeDocument({ id: 2, added: '2026-09-02', content: 'second' }),
  ]
  const paperless = fakePaperless({
    listTags: vi.fn(async () => v.tags),
    listCorrespondents: vi.fn(async () => v.correspondents),
    listInboxDocuments: vi.fn(async () => docs),
    listFiledDocuments: vi.fn(async () => [
      makeDocument({ id: 1, title: 'Self', tags: [2] }),
      makeDocument({ id: 50, title: 'Filed 50', tags: [2] }),
    ]),
  })
  const health = [...healthSequence]
  const llm: LlmClient = {
    complete: vi.fn(),
    health: vi.fn(async () => (health.length > 1 ? health.shift()! : health[0]!)),
  }
  const suggester = { suggest: vi.fn(async (_input: SuggestInput): Promise<SuggestResult> => okResult) }
  const worker = new Worker({ paperless, llm, suggester, store, inboxTag: null, pollIntervalSec: 300, logger: silentLogger })
  return { store, paperless, llm, suggester, worker, setDocs: (d: PaperlessDocument[]) => (docs = d) }
}

describe('Worker', () => {
  it('syncs the inbox but waits while the LLM is offline, with growing backoff', async () => {
    const { store, suggester, worker } = setup([offline])
    await worker.tick()
    expect(store.counts().pending).toBe(2)
    expect(suggester.suggest).not.toHaveBeenCalled()
    expect(worker.status().llm).toEqual({ ok: false, model: null, error: offline.error })
    expect(worker.nextDelayMs()).toBe(60_000)
    await worker.tick()
    expect(worker.nextDelayMs()).toBe(120_000)
    for (let i = 0; i < 6; i++) await worker.tick()
    expect(worker.nextDelayMs()).toBe(BACKOFF_MAX_MS)
  })

  it('processes pending documents oldest first when the LLM is online', async () => {
    const { store, suggester, worker } = setup()
    await worker.tick()
    expect(suggester.suggest.mock.calls.map((c) => c[0].content)).toEqual(['first', 'second'])
    expect(store.get(1)?.status).toBe('ready')
    expect(store.get(2)?.status).toBe('ready')
    expect(worker.status()).toMatchObject({ paperless: { ok: true }, llm: { ok: true, model: 'm' } })
    expect(worker.status().lastPollAt).not.toBeNull()
    expect(worker.nextDelayMs()).toBe(300_000)
  })

  it('never uses the document itself as a few-shot example', async () => {
    const { suggester, worker } = setup()
    await worker.tick()
    expect(suggester.suggest.mock.calls[0]![0].examples.map((e) => e.title)).toEqual(['Filed 50'])
  })

  it('resumes after the LLM comes back and resets the backoff', async () => {
    const { store, worker } = setup([offline, online])
    await worker.tick()
    await worker.tick()
    expect(store.counts()).toMatchObject({ ready: 2, pending: 0 })
    expect(worker.nextDelayMs()).toBe(300_000)
  })

  it('stops processing and keeps documents pending when the LLM drops mid-run', async () => {
    const { store, suggester, worker } = setup()
    suggester.suggest.mockResolvedValueOnce(okResult).mockRejectedValueOnce(new LlmError('socket hang up'))
    await worker.tick()
    expect(store.get(1)?.status).toBe('ready')
    expect(store.get(2)?.status).toBe('pending')
    expect(worker.status().llm).toEqual({ ok: false, model: null, error: 'socket hang up' })
    expect(worker.nextDelayMs()).toBe(60_000)
  })

  it('reports Paperless failures without throwing', async () => {
    const { paperless, llm, worker } = setup()
    vi.mocked(paperless.listTags).mockRejectedValueOnce(new PaperlessError('Paperless GET /api/tags/ failed: 502', 502))
    await expect(worker.tick()).resolves.toBeUndefined()
    expect(worker.status().paperless).toEqual({ ok: false, error: expect.stringContaining('502') })
    expect(llm.health).not.toHaveBeenCalled()
  })

  it('reports a missing inbox tag as a Paperless problem', async () => {
    const { paperless, worker } = setup()
    vi.mocked(paperless.listTags).mockResolvedValueOnce(makeVocabulary().tags.filter((t) => !t.isInboxTag))
    await worker.tick()
    expect(worker.status().paperless.error).toMatch(/INBOX_TAG/)
  })

  it('drops documents that left the inbox', async () => {
    const { store, worker, setDocs } = setup()
    await worker.tick()
    setDocs([makeDocument({ id: 2, added: '2026-09-02', content: 'second' })])
    await worker.tick()
    expect(store.nextReviewable()).toBe(2)
    expect(store.nextReviewable(2)).toBeNull()
  })

  it('runs in the background and reacts to wake()', async () => {
    const { store, suggester, worker } = setup()
    worker.start()
    try {
      await vi.waitFor(() => expect(suggester.suggest).toHaveBeenCalledTimes(2))
      store.requestRegenerate(1)
      worker.wake()
      await vi.waitFor(() => expect(suggester.suggest).toHaveBeenCalledTimes(3))
      expect(store.get(1)?.status).toBe('ready')
    } finally {
      worker.stop()
    }
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/worker/worker.test.ts`
Expected: FAIL, because `../../src/worker/worker` cannot be resolved.

- [ ] **Step 4: Implement `src/worker/worker.ts`**

```ts
import { createHash } from 'node:crypto'
import { LlmError, type LlmClient } from '../llm/client'
import type { PaperlessClient } from '../paperless/client'
import type { PaperlessDocument, Vocabulary } from '../paperless/types'
import { hashVocabulary, loadVocabulary } from '../paperless/vocabulary'
import type { SuggestionStore } from '../store/suggestions'
import { loadExamples } from '../suggest/examples'
import type { Suggester } from '../suggest/types'

export const BACKOFF_START_MS = 60_000
export const BACKOFF_MAX_MS = 600_000

export interface WorkerStatus {
  paperless: { ok: boolean; error: string | null }
  llm: { ok: boolean; model: string | null; error: string | null }
  lastPollAt: string | null
}

export interface WorkerDeps {
  paperless: PaperlessClient
  llm: LlmClient
  suggester: Suggester
  store: SuggestionStore
  inboxTag: string | null
  pollIntervalSec: number
  logger?: Pick<Console, 'info' | 'warn' | 'error'>
  now?: () => Date
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

export class Worker {
  private paperlessState: WorkerStatus['paperless'] = { ok: false, error: null }
  private llmState: WorkerStatus['llm'] = { ok: false, model: null, error: null }
  private lastPollAt: string | null = null
  private backoffMs = 0
  private timer: NodeJS.Timeout | undefined
  private running = false
  private wakeRequested = false
  private stopped = false
  private readonly log: Pick<Console, 'info' | 'warn' | 'error'>
  private readonly now: () => Date

  constructor(private readonly deps: WorkerDeps) {
    this.log = deps.logger ?? console
    this.now = deps.now ?? (() => new Date())
  }

  status(): WorkerStatus {
    return { paperless: { ...this.paperlessState }, llm: { ...this.llmState }, lastPollAt: this.lastPollAt }
  }

  nextDelayMs(): number {
    return this.llmState.ok || this.backoffMs === 0 ? this.deps.pollIntervalSec * 1000 : this.backoffMs
  }

  async tick(): Promise<void> {
    const { paperless, llm, store, suggester } = this.deps
    let vocab: Vocabulary
    let docs: PaperlessDocument[]
    try {
      vocab = await loadVocabulary(paperless, this.deps.inboxTag)
      docs = await paperless.listInboxDocuments(vocab.inboxTagId)
    } catch (e) {
      this.paperlessDown(e)
      return
    }
    this.paperlessState = { ok: true, error: null }
    this.lastPollAt = this.now().toISOString()

    const vocabHash = hashVocabulary(vocab)
    const byId = new Map(docs.map((d) => [d.id, d]))
    store.syncInbox(
      docs.map((d) => ({ documentId: d.id, added: d.added, contentHash: hashContent(d.content) })),
      vocabHash,
    )

    const health = await llm.health()
    if (!health.ok) {
      this.llmDown(health.error)
      return
    }
    this.llmState = { ok: true, model: health.model, error: null }
    this.backoffMs = 0

    for (let id = store.nextWork(); id !== null && !this.stopped; id = store.nextWork()) {
      try {
        const doc = byId.get(id) ?? (await paperless.getDocument(id))
        const examples = await loadExamples(paperless, vocab, doc.content, new Set([doc.id]))
        const result = await suggester.suggest({ content: doc.content, vocabulary: vocab, examples })
        store.saveResult(id, result, { contentHash: hashContent(doc.content), vocabHash, docModified: doc.modified })
        this.log.info(`Document ${id}: ${result.kind}`)
      } catch (e) {
        if (e instanceof LlmError) this.llmDown(e.message)
        else this.paperlessDown(e)
        return
      }
    }
  }

  start(): void {
    this.stopped = false
    this.schedule(0)
  }

  stop(): void {
    this.stopped = true
    clearTimeout(this.timer)
  }

  wake(): void {
    if (this.stopped) return
    if (this.running) this.wakeRequested = true
    else this.schedule(0)
  }

  private schedule(ms: number): void {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.run(), ms)
  }

  private async run(): Promise<void> {
    if (this.running) {
      this.wakeRequested = true
      return
    }
    this.running = true
    try {
      await this.tick()
    } catch (e) {
      this.log.error(`Worker tick failed: ${message(e)}`)
    } finally {
      this.running = false
    }
    if (this.stopped) return
    if (this.wakeRequested) {
      this.wakeRequested = false
      this.schedule(0)
    } else {
      this.schedule(this.nextDelayMs())
    }
  }

  private llmDown(error: string): void {
    this.llmState = { ok: false, model: null, error }
    this.backoffMs = this.backoffMs === 0 ? BACKOFF_START_MS : Math.min(this.backoffMs * 2, BACKOFF_MAX_MS)
    this.log.warn(`LLM unavailable: ${error}`)
  }

  private paperlessDown(e: unknown): void {
    this.paperlessState = { ok: false, error: message(e) }
    this.log.warn(`Paperless unavailable: ${message(e)}`)
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/worker && npm run typecheck`
Expected: 9 tests PASS; `tsc` exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/worker tests/worker tests/helpers/fakes.ts
git commit -m "feat: background worker with LLM backoff and inbox sync" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Apply to Paperless

**Files:**
- Create: `src/apply/apply.ts`
- Test: `tests/apply/apply.test.ts`

**Interfaces:**
- Consumes: `PaperlessClient` (Task 3); `Vocabulary`, `PaperlessDocument` (Task 3); `SuggestionStore` (Task 8)
- Produces:
  ```ts
  export const ApplyRequestSchema: z.ZodType   // validates the POST body
  export type EntityRef = { id: number } | { name: string }
  export interface ApplyRequest { title: string; correspondent: EntityRef | null; tags: EntityRef[]; expectedModified: string }
  export type ApplyResult =
    | { kind: 'applied'; document: PaperlessDocument }
    | { kind: 'conflict'; reason: 'modified'; current: PaperlessDocument }
    | { kind: 'conflict'; reason: 'missing'; missingTagIds: number[]; missingCorrespondentId: number | null }
  export function applySuggestion(deps: { paperless: PaperlessClient; store: SuggestionStore }, documentId: number, req: ApplyRequest, vocab: Vocabulary): Promise<ApplyResult>
  ```

- [ ] **Step 1: Write the failing test `tests/apply/apply.test.ts`**

```ts
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

  it('rejects blank or too long titles and empty names', () => {
    const base = { correspondent: null, tags: [], expectedModified: 'm' }
    expect(ApplyRequestSchema.safeParse({ ...base, title: '  ' }).success).toBe(false)
    expect(ApplyRequestSchema.safeParse({ ...base, title: 'x'.repeat(129) }).success).toBe(false)
    expect(ApplyRequestSchema.safeParse({ ...base, title: 'x', tags: [{ name: ' ' }] }).success).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/apply/apply.test.ts`
Expected: FAIL, because the module does not exist.

- [ ] **Step 3: Implement `src/apply/apply.ts`**

```ts
import { z } from 'zod'
import type { PaperlessClient } from '../paperless/client'
import type { PaperlessDocument, Vocabulary } from '../paperless/types'
import type { SuggestionStore } from '../store/suggestions'

const EntityRefSchema = z.union([
  z.object({ id: z.number().int().positive() }),
  z.object({ name: z.string().trim().min(1).max(128) }),
])

export const ApplyRequestSchema = z.object({
  title: z.string().trim().min(1).max(128),
  correspondent: EntityRefSchema.nullable(),
  tags: z.array(EntityRefSchema).max(50),
  expectedModified: z.string().min(1),
})

export type EntityRef = z.infer<typeof EntityRefSchema>
export type ApplyRequest = z.infer<typeof ApplyRequestSchema>

export type ApplyResult =
  | { kind: 'applied'; document: PaperlessDocument }
  | { kind: 'conflict'; reason: 'modified'; current: PaperlessDocument }
  | { kind: 'conflict'; reason: 'missing'; missingTagIds: number[]; missingCorrespondentId: number | null }

export async function applySuggestion(
  deps: { paperless: PaperlessClient; store: SuggestionStore },
  documentId: number,
  req: ApplyRequest,
  vocab: Vocabulary,
): Promise<ApplyResult> {
  const { paperless, store } = deps
  const current = await paperless.getDocument(documentId)
  if (current.modified !== req.expectedModified) return { kind: 'conflict', reason: 'modified', current }

  const tagIds = new Set(vocab.tags.map((t) => t.id))
  const correspondentIds = new Set(vocab.correspondents.map((c) => c.id))
  const missingTagIds = req.tags.flatMap((r) => ('id' in r && !tagIds.has(r.id) ? [r.id] : []))
  const missingCorrespondentId =
    req.correspondent && 'id' in req.correspondent && !correspondentIds.has(req.correspondent.id)
      ? req.correspondent.id
      : null
  if (missingTagIds.length > 0 || missingCorrespondentId !== null) {
    return { kind: 'conflict', reason: 'missing', missingTagIds, missingCorrespondentId }
  }

  const createdTags = new Map<string, number>()
  async function tagId(ref: EntityRef): Promise<number> {
    if ('id' in ref) return ref.id
    const key = ref.name.toLowerCase()
    const existing = vocab.tags.find((t) => t.name.toLowerCase() === key)?.id ?? createdTags.get(key)
    if (existing !== undefined) return existing
    const created = await paperless.createTag(ref.name)
    createdTags.set(key, created.id)
    return created.id
  }
  async function correspondentId(ref: EntityRef): Promise<number> {
    if ('id' in ref) return ref.id
    const existing = vocab.correspondents.find((c) => c.name.toLowerCase() === ref.name.toLowerCase())
    return existing ? existing.id : (await paperless.createCorrespondent(ref.name)).id
  }

  const correspondent = req.correspondent === null ? null : await correspondentId(req.correspondent)
  const tags: number[] = []
  for (const ref of req.tags) {
    const id = await tagId(ref)
    if (id !== vocab.inboxTagId && !tags.includes(id)) tags.push(id)
  }

  const document = await paperless.updateDocument(documentId, { title: req.title, correspondent, tags })
  store.markApplied(documentId)
  return { kind: 'applied', document }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/apply && npm run typecheck`
Expected: 10 tests PASS; `tsc` exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/apply tests/apply
git commit -m "feat: apply confirmed suggestions to Paperless with conflict checks" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Authentication

**Files:**
- Create: `src/api/auth.ts`
- Test: `tests/api/auth.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces:
  ```ts
  export const SESSION_COOKIE = 'ps_session'
  export const SESSION_MAX_AGE_S = 2_592_000
  export interface AuthOptions { password: string | null; disabled: boolean; secret: string; now?: () => number }
  export interface Auth { middleware: MiddlewareHandler; login(c: Context): Promise<Response>; logout(c: Context): Response }
  export function createAuth(opts: AuthOptions): Auth
  ```
  The session is a stateless signed cookie `<expiryUnixSeconds>.<HMAC-SHA256 base64url>`. The secret is persisted in the SQLite `meta` table by `server.ts` (Task 12), so sessions survive restarts.

- [ ] **Step 1: Write the failing test `tests/api/auth.test.ts`**

```ts
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { createAuth, type AuthOptions } from '../../src/api/auth'

function setup(opts: Partial<AuthOptions> = {}) {
  let time = Date.parse('2026-09-29T10:00:00Z')
  const auth = createAuth({ password: 'pw', disabled: false, secret: 's3cret', now: () => time, ...opts })
  const app = new Hono()
  app.post('/api/login', (c) => auth.login(c))
  app.post('/api/logout', (c) => auth.logout(c))
  app.use('/api/*', auth.middleware)
  app.get('/api/secret', (c) => c.text('ok'))
  const login = (password: string, headers: Record<string, string> = {}) =>
    app.request('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ password }),
    })
  const secret = (cookie?: string) => app.request('/api/secret', { headers: cookie ? { cookie } : {} })
  return { app, login, secret, advance: (ms: number) => (time += ms) }
}

const cookieOf = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0]!

describe('auth', () => {
  it('lets everything through when disabled', async () => {
    const { secret } = setup({ disabled: true })
    expect((await secret()).status).toBe(200)
  })

  it('rejects requests without a session', async () => {
    const { secret } = setup()
    expect((await secret()).status).toBe(401)
  })

  it('rejects a wrong password', async () => {
    const { login } = setup()
    expect((await login('nope')).status).toBe(401)
  })

  it('issues a 30-day HttpOnly Lax cookie that grants access', async () => {
    const { login, secret } = setup()
    const res = await login('pw')
    expect(res.status).toBe(200)
    const header = res.headers.get('set-cookie') ?? ''
    expect(header).toContain('HttpOnly')
    expect(header).toContain('SameSite=Lax')
    expect(header).toContain('Max-Age=2592000')
    expect(header).toContain('Path=/')
    expect(header).not.toContain('Secure')
    expect((await secret(cookieOf(res))).status).toBe(200)
  })

  it('marks the cookie Secure behind an HTTPS proxy', async () => {
    const { login } = setup()
    const res = await login('pw', { 'x-forwarded-proto': 'https' })
    expect(res.headers.get('set-cookie')).toContain('Secure')
  })

  it('expires sessions after 30 days', async () => {
    const { login, secret, advance } = setup()
    const cookie = cookieOf(await login('pw'))
    advance(31 * 24 * 60 * 60 * 1000)
    expect((await secret(cookie)).status).toBe(401)
  })

  it('rejects tampered cookies', async () => {
    const { login, secret } = setup()
    const cookie = cookieOf(await login('pw'))
    const [name, value] = cookie.split('=')
    const [exp] = value!.split('.')
    expect((await secret(`${name}=${Number(exp) + 999999}.${value!.split('.')[1]}`)).status).toBe(401)
    expect((await secret(`${name}=garbage`)).status).toBe(401)
  })

  it('rate-limits login after 10 failures for 15 minutes', async () => {
    const { login, advance } = setup()
    for (let i = 0; i < 10; i++) expect((await login('nope')).status).toBe(401)
    expect((await login('pw')).status).toBe(429)
    advance(15 * 60 * 1000 + 1)
    expect((await login('pw')).status).toBe(200)
  })

  it('clears the cookie on logout', async () => {
    const { app } = setup()
    const res = await app.request('/api/logout', { method: 'POST' })
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/api/auth.test.ts`
Expected: FAIL, because the module does not exist.

- [ ] **Step 3: Implement `src/api/auth.ts`**

```ts
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { Context, MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'

export const SESSION_COOKIE = 'ps_session'
export const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60
const MAX_FAILURES = 10
const FAILURE_WINDOW_MS = 15 * 60 * 1000

export interface AuthOptions {
  password: string | null
  disabled: boolean
  secret: string
  now?: () => number
}

export interface Auth {
  middleware: MiddlewareHandler
  login(c: Context): Promise<Response>
  logout(c: Context): Response
}

const digest = (s: string) => createHash('sha256').update(s).digest()

export function createAuth(opts: AuthOptions): Auth {
  const now = opts.now ?? Date.now
  let failures: number[] = []

  const sign = (exp: number) => createHmac('sha256', opts.secret).update(String(exp)).digest('base64url')

  function isValid(token: string | undefined): boolean {
    if (!token) return false
    const [expPart, sig] = token.split('.')
    const exp = Number(expPart)
    if (!sig || !Number.isInteger(exp) || exp * 1000 < now()) return false
    const expected = Buffer.from(sign(exp))
    const given = Buffer.from(sig)
    return expected.length === given.length && timingSafeEqual(expected, given)
  }

  const isHttps = (c: Context) =>
    new URL(c.req.url).protocol === 'https:' || c.req.header('x-forwarded-proto') === 'https'

  return {
    middleware: async (c, next) => {
      if (opts.disabled || isValid(getCookie(c, SESSION_COOKIE))) return next()
      return c.json({ error: 'unauthorized' }, 401)
    },

    async login(c) {
      if (opts.disabled) return c.json({ ok: true })
      const t = now()
      failures = failures.filter((f) => t - f < FAILURE_WINDOW_MS)
      if (failures.length >= MAX_FAILURES) return c.json({ error: 'Too many attempts, try again later' }, 429)
      const body = (await c.req.json().catch(() => null)) as { password?: unknown } | null
      const password = typeof body?.password === 'string' ? body.password : ''
      if (!opts.password || !timingSafeEqual(digest(password), digest(opts.password))) {
        failures.push(t)
        return c.json({ error: 'Wrong password' }, 401)
      }
      const exp = Math.floor(t / 1000) + SESSION_MAX_AGE_S
      setCookie(c, SESSION_COOKIE, `${exp}.${sign(exp)}`, {
        httpOnly: true,
        sameSite: 'Lax',
        secure: isHttps(c),
        path: '/',
        maxAge: SESSION_MAX_AGE_S,
      })
      return c.json({ ok: true })
    },

    logout(c) {
      deleteCookie(c, SESSION_COOKIE, { path: '/' })
      return c.json({ ok: true })
    },
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/api/auth.test.ts && npm run typecheck`
Expected: 9 tests PASS; `tsc` exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/api/auth.ts tests/api/auth.test.ts
git commit -m "feat: single-user session auth with rate-limited login" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: HTTP API, static serving and server entry

**Files:**
- Create: `src/api/types.ts`, `src/api/static.ts`, `src/api/app.ts`, `src/server.ts`
- Test: `tests/api/app.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 3, 4, 7, 8, 9, 10, 11
- Produces:
  ```ts
  // api/types.ts (the web app imports these with `import type`)
  export interface NamedRef { id: number; name: string }
  export interface DocumentDetail {
    document: { id: number; title: string; content: string; correspondentId: number | null; tagIds: number[]; modified: string; added: string }
    suggestion: StoredSuggestion | null
    vocabulary: { inboxTagId: number; tags: NamedRef[]; correspondents: NamedRef[] }   // tags exclude the inbox tag
  }
  export type StatusResponse = WorkerStatus & { counts: StatusCounts }
  export type ApplyRequestBody = ApplyRequest
  export type ApplyConflict = { reason: 'modified'; current: PaperlessDocument } | { reason: 'missing'; missingTagIds: number[]; missingCorrespondentId: number | null }
  export type { StoredSuggestion, SuggestionStatus, NearMatch, Proposal }
  // api/static.ts
  export function serveSpa(rootDir: string): Handler
  // api/app.ts
  export interface AppDeps { paperless: PaperlessClient; store: SuggestionStore; worker: Pick<Worker, 'status' | 'wake'>; auth: Auth; inboxTag: string | null; staticDir: string | null }
  export function createApp(deps: AppDeps): Hono
  ```
  Routes: `POST /api/login`, `POST /api/logout`, `GET /api/status` → `StatusResponse`, `GET /api/queue/next?after=<id>` → `{ documentId: number | null }`, `GET /api/documents/:id` → `DocumentDetail`, `GET /api/documents/:id/thumb|preview` → proxied file, `POST /api/documents/:id/apply` → `{ status: 'applied' }` or 409 `ApplyConflict` or 400 `{ error }`, `POST /api/documents/:id/regenerate` → `{ status: 'pending' }` or 404. A Paperless failure returns 502 `{ error }`.

- [ ] **Step 1: Create `src/api/types.ts`**

```ts
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
```

- [ ] **Step 2: Write the failing test `tests/api/app.test.ts`**

```ts
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/api/app.test.ts`
Expected: FAIL, because `../../src/api/app` cannot be resolved.

- [ ] **Step 4: Implement `src/api/static.ts`**

```ts
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Handler } from 'hono'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
}

/** Serves files from rootDir; unknown paths get index.html so client-side routes work. */
export function serveSpa(rootDir: string): Handler {
  const root = path.resolve(rootDir)
  const index = path.join(root, 'index.html')
  return async (c) => {
    let file = index
    try {
      const rel = decodeURIComponent(new URL(c.req.url).pathname)
      const candidate = path.resolve(root, `.${rel}`)
      if (candidate.startsWith(root + path.sep) && (await stat(candidate).catch(() => null))?.isFile()) {
        file = candidate
      }
    } catch {
      file = index
    }
    const body = new Uint8Array(await readFile(file))
    const immutable = file.startsWith(path.join(root, 'assets') + path.sep)
    return c.body(body, 200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    })
  }
}
```

- [ ] **Step 5: Implement `src/api/app.ts`**

```ts
import { Hono } from 'hono'
import { applySuggestion, ApplyRequestSchema } from '../apply/apply'
import { PaperlessError, type PaperlessClient } from '../paperless/client'
import { loadVocabulary, selectableTags } from '../paperless/vocabulary'
import type { SuggestionStore } from '../store/suggestions'
import type { Worker } from '../worker/worker'
import type { Auth } from './auth'
import { serveSpa } from './static'
import type { DocumentDetail, StatusResponse } from './types'

export interface AppDeps {
  paperless: PaperlessClient
  store: SuggestionStore
  worker: Pick<Worker, 'status' | 'wake'>
  auth: Auth
  inboxTag: string | null
  staticDir: string | null
}

const parseId = (v: string | undefined): number | null =>
  v !== undefined && /^\d+$/.test(v) && Number(v) > 0 ? Number(v) : null

export function createApp(deps: AppDeps): Hono {
  const { paperless, store, worker, auth } = deps
  const app = new Hono()

  app.onError((err, c) => {
    if (err instanceof PaperlessError) return c.json({ error: err.message }, 502)
    console.error(err)
    return c.json({ error: err.message || 'Internal error' }, 500)
  })

  // Registered before the auth middleware, so they stay reachable without a session.
  app.post('/api/login', (c) => auth.login(c))
  app.post('/api/logout', (c) => auth.logout(c))
  app.use('/api/*', auth.middleware)

  app.get('/api/status', (c) => {
    const body: StatusResponse = { ...worker.status(), counts: store.counts() }
    return c.json(body)
  })

  app.get('/api/queue/next', (c) => {
    const after = c.req.query('after')
    const afterId = after === undefined ? undefined : parseId(after)
    if (afterId === null) return c.json({ error: 'invalid after' }, 400)
    return c.json({ documentId: store.nextReviewable(afterId) })
  })

  app.get('/api/documents/:id', async (c) => {
    const id = parseId(c.req.param('id'))
    if (id === null) return c.json({ error: 'invalid id' }, 400)
    const [doc, vocab] = await Promise.all([paperless.getDocument(id), loadVocabulary(paperless, deps.inboxTag)])
    const body: DocumentDetail = {
      document: {
        id: doc.id,
        title: doc.title,
        content: doc.content,
        correspondentId: doc.correspondent,
        tagIds: doc.tags,
        modified: doc.modified,
        added: doc.added,
      },
      suggestion: store.get(id),
      vocabulary: {
        inboxTagId: vocab.inboxTagId,
        tags: selectableTags(vocab).map(({ id: tagId, name }) => ({ id: tagId, name })),
        correspondents: vocab.correspondents.map(({ id: cId, name }) => ({ id: cId, name })),
      },
    }
    return c.json(body)
  })

  for (const kind of ['thumb', 'preview'] as const) {
    app.get(`/api/documents/:id/${kind}`, async (c) => {
      const id = parseId(c.req.param('id'))
      if (id === null) return c.json({ error: 'invalid id' }, 400)
      const res = await paperless.fetchFile(id, kind)
      return new Response(res.body, {
        headers: {
          'Content-Type': res.headers.get('content-type') ?? 'application/octet-stream',
          'Cache-Control': 'private, max-age=300',
        },
      })
    })
  }

  app.post('/api/documents/:id/apply', async (c) => {
    const id = parseId(c.req.param('id'))
    if (id === null) return c.json({ error: 'invalid id' }, 400)
    const parsed = ApplyRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }, 400)
    }
    const vocab = await loadVocabulary(paperless, deps.inboxTag)
    const result = await applySuggestion({ paperless, store }, id, parsed.data, vocab)
    if (result.kind === 'applied') return c.json({ status: 'applied' })
    const { kind: _kind, ...conflict } = result
    return c.json(conflict, 409)
  })

  app.post('/api/documents/:id/regenerate', (c) => {
    const id = parseId(c.req.param('id'))
    if (id === null) return c.json({ error: 'invalid id' }, 400)
    if (!store.requestRegenerate(id)) return c.json({ error: 'document is not in the queue' }, 404)
    worker.wake()
    return c.json({ status: 'pending' })
  })

  app.all('/api/*', (c) => c.json({ error: 'not found' }, 404))

  if (deps.staticDir) app.get('*', serveSpa(deps.staticDir))

  return app
}
```

- [ ] **Step 6: Run the API test to verify it passes**

Run: `npx vitest run tests/api && npm run typecheck`
Expected: all PASS; `tsc` exits 0.

- [ ] **Step 7: Implement `src/server.ts`**

```ts
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { serve } from '@hono/node-server'
import { createApp } from './api/app'
import { createAuth } from './api/auth'
import { ConfigError, loadConfig, type Config } from './config'
import { createLlmClient } from './llm/client'
import { createPaperlessClient } from './paperless/client'
import { InboxTagError, loadVocabulary } from './paperless/vocabulary'
import { openDb } from './store/db'
import { SuggestionStore } from './store/suggestions'
import { createSuggester } from './suggest/suggester'
import { Worker } from './worker/worker'

async function main(): Promise<void> {
  let config: Config
  try {
    config = loadConfig(process.env)
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message)
      process.exit(1)
    }
    throw e
  }

  mkdirSync(config.dataDir, { recursive: true })
  const db = openDb(path.join(config.dataDir, 'paperless-suggest.sqlite'))
  const store = new SuggestionStore(db)
  const paperless = createPaperlessClient({ baseUrl: config.paperlessUrl, token: config.paperlessToken })
  const llm = createLlmClient({ baseUrl: config.llmBaseUrl, model: config.llmModel })
  const suggester = createSuggester({
    llm,
    maxContentChars: config.maxContentChars,
    matchThreshold: config.newNameMatchThreshold,
  })
  const worker = new Worker({
    paperless,
    llm,
    suggester,
    store,
    inboxTag: config.inboxTag,
    pollIntervalSec: config.pollIntervalSec,
  })

  try {
    const vocab = await loadVocabulary(paperless, config.inboxTag)
    console.info(`Paperless reachable; inbox tag id ${vocab.inboxTagId}`)
  } catch (e) {
    if (e instanceof InboxTagError) {
      console.error(e.message)
      process.exit(1)
    }
    console.warn(`Paperless not reachable at startup, will keep retrying: ${(e as Error).message}`)
  }

  let secret = store.getMeta('session_secret')
  if (!secret) {
    secret = randomBytes(32).toString('hex')
    store.setMeta('session_secret', secret)
  }
  const auth = createAuth({ password: config.appPassword, disabled: config.authDisabled, secret })

  const webDir = path.join(import.meta.dirname, 'web')
  const app = createApp({
    paperless,
    store,
    worker,
    auth,
    inboxTag: config.inboxTag,
    staticDir: existsSync(webDir) ? webDir : null,
  })

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.info(`Listening on http://0.0.0.0:${info.port}`)
  })
  worker.start()

  const shutdown = () => {
    worker.stop()
    server.close(() => {
      db.close()
      process.exit(0)
    })
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
```

- [ ] **Step 8: Smoke-test the server against an unreachable Paperless**

Run:
```bash
PAPERLESS_URL=http://127.0.0.1:9 PAPERLESS_TOKEN=x LLM_BASE_URL=http://127.0.0.1:9/v1 AUTH_DISABLED=true DATA_DIR=./.tmp-data PORT=3999 npx tsx src/server.ts & SERVER_PID=$!; sleep 4; curl -s localhost:3999/api/status; echo; kill $SERVER_PID; rm -rf ./.tmp-data
```
Expected: the log shows `Paperless not reachable at startup, will keep retrying` and `Listening on http://0.0.0.0:3999`. The curl prints JSON with `"paperless":{"ok":false,...}` and `"counts":{"ready":0,"pending":0,"error":0,"noText":0}`.

Run: `PAPERLESS_URL=x npx tsx src/server.ts; echo "exit=$?"`
Expected: `Invalid configuration:` listing the invalid/missing variables, then `exit=1`.

- [ ] **Step 9: Commit**

```bash
git add src/api src/server.ts tests/api/app.test.ts
git commit -m "feat: HTTP API, SPA serving and server entry point" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 13: Web scaffold, API client and edit-state logic

**Files:**
- Create: `web/index.html`, `web/vite.config.ts`, `web/src/index.css`, `web/src/api.ts`, `web/src/editState.ts`, `web/src/test/fixtures.ts`, `vitest.setup.ts`
- Modify: `vitest.config.ts` (add React plugin + setup file)
- Test: `web/src/editState.test.ts`

**Interfaces:**
- Consumes: types from `src/api/types.ts` (Task 12), imported with `import type`; `rankMatches` (Task 2) as runtime code, since it is pure
- Produces:
  ```ts
  // api.ts
  export class UnauthorizedError extends Error {}
  export class ApiError extends Error { readonly status: number; readonly body: unknown }
  export const api: {
    login(password: string): Promise<{ ok: true }>
    status(): Promise<StatusResponse>
    nextDocument(after?: number): Promise<{ documentId: number | null }>
    document(id: number): Promise<DocumentDetail>
    apply(id: number, body: ApplyRequestBody): Promise<{ status: 'applied' }>
    regenerate(id: number): Promise<{ status: 'pending' }>
  }
  export function fileUrl(id: number, kind: 'thumb' | 'preview'): string
  // editState.ts
  export type EntityEntry = { kind: 'existing'; id: number; matchedFrom?: string } | { kind: 'new'; name: string; nearest: NearMatch[] }
  export type TagEntry = EntityEntry
  export type CorrespondentEntry = EntityEntry | null
  export interface EditState { title: string; correspondent: CorrespondentEntry; tags: TagEntry[] }
  export function initialEditState(detail: DocumentDetail): EditState
  export function removeTagAt(tags: TagEntry[], index: number): TagEntry[]
  export function addExistingTag(tags: TagEntry[], id: number): TagEntry[]
  export function addNewTag(tags: TagEntry[], name: string, options: NamedRef[]): TagEntry[]
  export function replaceNewTag(tags: TagEntry[], index: number, id: number): TagEntry[]
  export function canApply(state: EditState): boolean
  export function toApplyRequest(state: EditState, expectedModified: string): ApplyRequestBody
  export function applyMissing(state: EditState, missing: { missingTagIds: number[]; missingCorrespondentId: number | null }, vocabulary: DocumentDetail['vocabulary']): EditState
  // test/fixtures.ts
  export function makeDetail(opts?: { id?: number; suggestion?: Partial<StoredSuggestion> | null; document?: Partial<DocumentDetail['document']> }): DocumentDetail
  export function makeStatus(overrides?: Partial<StatusResponse>): StatusResponse
  ```

- [ ] **Step 1: Install frontend dependencies**

Run:
```bash
npm i react react-dom @tanstack/react-query
npm i -D vite @vitejs/plugin-react tailwindcss @tailwindcss/vite @types/react @types/react-dom jsdom @testing-library/react @testing-library/user-event @testing-library/jest-dom
```
Expected: installs succeed.

- [ ] **Step 2: Create `web/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="theme-color" content="#ffffff" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <title>Paperless Suggest</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 3: Create `web/vite.config.ts`**

```ts
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react(), tailwindcss()],
  build: {
    outDir: fileURLToPath(new URL('../dist/web', import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000' },
  },
})
```

- [ ] **Step 4: Create `web/src/index.css`**

```css
@import "tailwindcss";

@theme {
  /* desktop split view from 900px */
  --breakpoint-desk: 56.25rem;
}

html,
body,
#root {
  height: 100%;
}
```

- [ ] **Step 5: Update `vitest.config.ts` and create `vitest.setup.ts`**

`vitest.config.ts`:
```ts
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['tests/**/*.test.ts', 'web/src/**/*.test.{ts,tsx}'],
    setupFiles: ['./vitest.setup.ts'],
  },
})
```

`vitest.setup.ts`:
```ts
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(() => cleanup())
```

- [ ] **Step 6: Create `web/src/api.ts`**

```ts
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
```

- [ ] **Step 7: Create `web/src/test/fixtures.ts`**

```ts
import type { DocumentDetail, StatusResponse, StoredSuggestion } from '../../../src/api/types'

export function makeDetail(
  opts: { id?: number; suggestion?: Partial<StoredSuggestion> | null; document?: Partial<DocumentDetail['document']> } = {},
): DocumentDetail {
  const id = opts.id ?? 1
  return {
    document: {
      id,
      title: `scan_${id}`,
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
```

- [ ] **Step 8: Write the failing test `web/src/editState.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import {
  addExistingTag,
  addNewTag,
  applyMissing,
  canApply,
  initialEditState,
  removeTagAt,
  replaceNewTag,
  toApplyRequest,
  type TagEntry,
} from './editState'
import { makeDetail } from './test/fixtures'

const options = makeDetail().vocabulary.tags

describe('initialEditState', () => {
  it('takes a ready suggestion', () => {
    expect(initialEditState(makeDetail())).toEqual({
      title: 'Telekom Rechnung 1',
      correspondent: { kind: 'existing', id: 10 },
      tags: [
        { kind: 'existing', id: 2 },
        { kind: 'new', name: 'Mobilfunk', nearest: [{ id: 3, name: 'Telefon/Internet', score: 0.4 }] },
      ],
    })
  })

  it('keeps tags already on the document, without the inbox tag or duplicates', () => {
    const s = initialEditState(makeDetail({ document: { tagIds: [1, 4, 2] }, suggestion: { tagIds: [2, 3], proposedTags: [] } }))
    expect(s.tags).toEqual([
      { kind: 'existing', id: 4 },
      { kind: 'existing', id: 2 },
      { kind: 'existing', id: 3 },
    ])
  })

  it('marks auto-matched entries', () => {
    const s = initialEditState(makeDetail({ suggestion: { matchedNotes: { Telekom: 'Deutsche Telekom AG', Rechnungen: 'Rechnung' } } }))
    expect(s.correspondent).toEqual({ kind: 'existing', id: 10, matchedFrom: 'Telekom' })
    expect(s.tags[0]).toEqual({ kind: 'existing', id: 2, matchedFrom: 'Rechnungen' })
  })

  it('turns a proposed correspondent into a NEW entry', () => {
    const s = initialEditState(
      makeDetail({ suggestion: { correspondentId: null, proposedCorrespondent: { name: 'Neue GmbH', nearest: [] } } }),
    )
    expect(s.correspondent).toEqual({ kind: 'new', name: 'Neue GmbH', nearest: [] })
  })

  it('falls back to the current document values without a ready suggestion', () => {
    const expected = { title: 'scan_1', correspondent: { kind: 'existing', id: 11 }, tags: [{ kind: 'existing', id: 4 }] }
    const document = { correspondentId: 11, tagIds: [1, 4] }
    expect(initialEditState(makeDetail({ document, suggestion: { status: 'error', error: 'x' } }))).toEqual(expected)
    expect(initialEditState(makeDetail({ document, suggestion: null }))).toEqual(expected)
  })
})

describe('tag operations', () => {
  const tags: TagEntry[] = [
    { kind: 'existing', id: 2 },
    { kind: 'new', name: 'Mobilfunk', nearest: [] },
  ]

  it('adds existing tags once and removes by index', () => {
    expect(addExistingTag(tags, 2)).toBe(tags)
    expect(addExistingTag(tags, 4)).toEqual([...tags, { kind: 'existing', id: 4 }])
    expect(removeTagAt(tags, 0)).toEqual([tags[1]])
  })

  it('replaces a NEW tag in place, without duplicating', () => {
    expect(replaceNewTag(tags, 1, 3)).toEqual([{ kind: 'existing', id: 2 }, { kind: 'existing', id: 3 }])
    expect(replaceNewTag(tags, 1, 2)).toEqual([{ kind: 'existing', id: 2 }])
  })

  it('adds a typed name as existing tag when it matches, else as NEW with nearest', () => {
    expect(addNewTag([], 'rechnung', options)).toEqual([{ kind: 'existing', id: 2 }])
    expect(addNewTag(tags, 'mobilfunk', options)).toBe(tags)
    expect(addNewTag([], '  ', options)).toEqual([])
    const added = addNewTag([], 'Rechnungen', options)
    expect(added[0]).toMatchObject({ kind: 'new', name: 'Rechnungen' })
    expect(added[0]!.kind === 'new' && added[0]!.nearest[0]?.name).toBe('Rechnung')
  })
})

describe('toApplyRequest / canApply', () => {
  it('maps entries to ids and names', () => {
    const s = { title: '  T  ', correspondent: { kind: 'new' as const, name: ' Neu ', nearest: [] }, tags: [{ kind: 'existing' as const, id: 2 }, { kind: 'new' as const, name: 'X', nearest: [] }] }
    expect(toApplyRequest(s, 'm')).toEqual({ title: 'T', correspondent: { name: 'Neu' }, tags: [{ id: 2 }, { name: 'X' }], expectedModified: 'm' })
    expect(toApplyRequest({ ...s, correspondent: null }, 'm').correspondent).toBeNull()
  })

  it('requires a title and a name for a new correspondent', () => {
    expect(canApply({ title: 'T', correspondent: null, tags: [] })).toBe(true)
    expect(canApply({ title: ' ', correspondent: null, tags: [] })).toBe(false)
    expect(canApply({ title: 'T', correspondent: { kind: 'new', name: '', nearest: [] }, tags: [] })).toBe(false)
  })
})

describe('applyMissing', () => {
  it('turns deleted entries into NEW entries with their old names', () => {
    const detail = makeDetail()
    const s = applyMissing(
      { title: 'T', correspondent: { kind: 'existing', id: 10 }, tags: [{ kind: 'existing', id: 2 }, { kind: 'existing', id: 4 }] },
      { missingTagIds: [2], missingCorrespondentId: 10 },
      detail.vocabulary,
    )
    expect(s.correspondent).toMatchObject({ kind: 'new', name: 'Deutsche Telekom AG' })
    expect(s.tags).toEqual([{ kind: 'new', name: 'Rechnung', nearest: expect.any(Array) }, { kind: 'existing', id: 4 }])
  })
})
```

- [ ] **Step 9: Run the test to verify it fails**

Run: `npx vitest run web/src/editState.test.ts`
Expected: FAIL, because `./editState` cannot be resolved.

- [ ] **Step 10: Implement `web/src/editState.ts`**

```ts
import type { ApplyRequestBody, DocumentDetail, NamedRef, NearMatch } from '../../src/api/types'
import { rankMatches } from '../../src/suggest/normalize'

export type EntityEntry =
  | { kind: 'existing'; id: number; matchedFrom?: string }
  | { kind: 'new'; name: string; nearest: NearMatch[] }
export type TagEntry = EntityEntry
export type CorrespondentEntry = EntityEntry | null

export interface EditState {
  title: string
  correspondent: CorrespondentEntry
  tags: TagEntry[]
}

const hasExisting = (tags: TagEntry[], id: number) => tags.some((t) => t.kind === 'existing' && t.id === id)

export function initialEditState(detail: DocumentDetail): EditState {
  const { document: doc, suggestion: s, vocabulary: v } = detail
  const currentTags: TagEntry[] = doc.tagIds.filter((id) => id !== v.inboxTagId).map((id) => ({ kind: 'existing', id }))
  const currentCorrespondent: CorrespondentEntry =
    doc.correspondentId === null ? null : { kind: 'existing', id: doc.correspondentId }

  if (!s || s.status !== 'ready') {
    return { title: doc.title, correspondent: currentCorrespondent, tags: currentTags }
  }

  const existing = (id: number, list: NamedRef[]): EntityEntry => {
    const name = list.find((e) => e.id === id)?.name
    const from = Object.entries(s.matchedNotes).find(([, to]) => to === name)?.[0]
    return from === undefined ? { kind: 'existing', id } : { kind: 'existing', id, matchedFrom: from }
  }

  const correspondent: CorrespondentEntry =
    s.correspondentId !== null
      ? existing(s.correspondentId, v.correspondents)
      : s.proposedCorrespondent
        ? { kind: 'new', name: s.proposedCorrespondent.name, nearest: s.proposedCorrespondent.nearest }
        : currentCorrespondent

  const tags = [...currentTags]
  for (const id of s.tagIds) if (!hasExisting(tags, id)) tags.push(existing(id, v.tags))
  for (const p of s.proposedTags) tags.push({ kind: 'new', name: p.name, nearest: p.nearest })

  return { title: s.title ?? doc.title, correspondent, tags }
}

export function removeTagAt(tags: TagEntry[], index: number): TagEntry[] {
  return tags.filter((_, i) => i !== index)
}

export function addExistingTag(tags: TagEntry[], id: number): TagEntry[] {
  return hasExisting(tags, id) ? tags : [...tags, { kind: 'existing', id }]
}

export function addNewTag(tags: TagEntry[], name: string, options: NamedRef[]): TagEntry[] {
  const trimmed = name.trim()
  if (!trimmed) return tags
  const key = trimmed.toLowerCase()
  const match = options.find((o) => o.name.toLowerCase() === key)
  if (match) return addExistingTag(tags, match.id)
  if (tags.some((t) => t.kind === 'new' && t.name.toLowerCase() === key)) return tags
  return [...tags, { kind: 'new', name: trimmed, nearest: rankMatches(trimmed, options) }]
}

export function replaceNewTag(tags: TagEntry[], index: number, id: number): TagEntry[] {
  const without = removeTagAt(tags, index)
  if (hasExisting(without, id)) return without
  return [...without.slice(0, index), { kind: 'existing', id }, ...without.slice(index)]
}

export function canApply(state: EditState): boolean {
  return state.title.trim().length > 0 && (state.correspondent?.kind !== 'new' || state.correspondent.name.trim().length > 0)
}

export function toApplyRequest(state: EditState, expectedModified: string): ApplyRequestBody {
  const ref = (e: EntityEntry) => (e.kind === 'existing' ? { id: e.id } : { name: e.name.trim() })
  return {
    title: state.title.trim(),
    correspondent: state.correspondent === null ? null : ref(state.correspondent),
    tags: state.tags.map(ref),
    expectedModified,
  }
}

export function applyMissing(
  state: EditState,
  missing: { missingTagIds: number[]; missingCorrespondentId: number | null },
  vocabulary: DocumentDetail['vocabulary'],
): EditState {
  const toNew = (id: number, list: NamedRef[]): EntityEntry => {
    const name = list.find((e) => e.id === id)?.name ?? `#${id}`
    return { kind: 'new', name, nearest: rankMatches(name, list.filter((e) => e.id !== id)) }
  }
  const c = state.correspondent
  return {
    ...state,
    correspondent:
      c?.kind === 'existing' && c.id === missing.missingCorrespondentId ? toNew(c.id, vocabulary.correspondents) : c,
    tags: state.tags.map((t) =>
      t.kind === 'existing' && missing.missingTagIds.includes(t.id) ? toNew(t.id, vocabulary.tags) : t,
    ),
  }
}
```

- [ ] **Step 11: Run tests and typecheck**

Run: `npx vitest run web/src/editState.test.ts && npm run typecheck`
Expected: 11 tests PASS; `tsc` exits 0.

- [ ] **Step 12: Commit**

```bash
git add package.json package-lock.json vitest.config.ts vitest.setup.ts web
git commit -m "feat: web scaffold, API client and review edit-state logic" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Tag editor and correspondent picker components

**Files:**
- Create: `web/src/TagEditor.tsx`, `web/src/CorrespondentPicker.tsx`
- Test: `web/src/TagEditor.test.tsx`, `web/src/CorrespondentPicker.test.tsx`

**Interfaces:**
- Consumes: `TagEntry`, `CorrespondentEntry`, `removeTagAt`, `addExistingTag`, `addNewTag`, `replaceNewTag` (Task 13); `rankMatches` (Task 2); `NamedRef` (Task 12)
- Produces:
  ```tsx
  export function TagEditor(props: { value: TagEntry[]; options: NamedRef[]; onChange(next: TagEntry[]): void }): JSX.Element
  export function CorrespondentPicker(props: { value: CorrespondentEntry; options: NamedRef[]; onChange(next: CorrespondentEntry): void }): JSX.Element
  ```
  Accessible names the later tests rely on: buttons `Remove <name>`, `Use <existing> instead of <new>`, `+ add tag`, `Create new tag “<name>”`; input `Search tags`; select `Correspondent` (option `Create new…`); input `New correspondent name`; button `Use <existing> instead`. The tag search box sits inside `[data-no-enter-apply]`, so Enter there does not trigger Apply.

- [ ] **Step 1: Write the failing test `web/src/TagEditor.test.tsx`**

```tsx
// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { TagEntry } from './editState'
import { TagEditor } from './TagEditor'
import { makeDetail } from './test/fixtures'

const options = makeDetail().vocabulary.tags

function setup(initial: TagEntry[]) {
  const onChange = vi.fn()
  function Harness() {
    const [value, setValue] = useState(initial)
    return (
      <TagEditor
        value={value}
        options={options}
        onChange={(next) => {
          setValue(next)
          onChange(next)
        }}
      />
    )
  }
  render(<Harness />)
  return { onChange, user: userEvent.setup(), last: () => onChange.mock.calls.at(-1)?.[0] as TagEntry[] }
}

const initial: TagEntry[] = [
  { kind: 'existing', id: 2, matchedFrom: 'Rechnungen' },
  { kind: 'existing', id: 5 },
  { kind: 'new', name: 'Mobilfunk', nearest: [{ id: 3, name: 'Telefon/Internet', score: 0.4 }] },
]

describe('TagEditor', () => {
  it('shows existing chips, NEW chips with alternatives, and match notes', () => {
    setup(initial)
    expect(screen.getByText('Rechnung')).toBeInTheDocument()
    expect(screen.getByText('Müller "Bau"')).toBeInTheDocument()
    expect(screen.getByText('NEW: Mobilfunk')).toBeInTheDocument()
    expect(screen.getByText(/matched from “Rechnungen”/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Use Telefon/Internet instead of Mobilfunk' })).toBeInTheDocument()
  })

  it('swaps a NEW chip for a suggested existing tag', async () => {
    const { user, last } = setup(initial)
    await user.click(screen.getByRole('button', { name: 'Use Telefon/Internet instead of Mobilfunk' }))
    expect(last()).toEqual([initial[0], initial[1], { kind: 'existing', id: 3 }])
    expect(screen.queryByText('NEW: Mobilfunk')).not.toBeInTheDocument()
  })

  it('removes chips', async () => {
    const { user, last } = setup(initial)
    await user.click(screen.getByRole('button', { name: 'Remove Rechnung' }))
    expect(last()).toEqual([initial[1], initial[2]])
  })

  it('adds an existing tag via search and Enter', async () => {
    const { user, last } = setup([])
    await user.click(screen.getByRole('button', { name: '+ add tag' }))
    await user.type(screen.getByLabelText('Search tags'), 'vers{Enter}')
    expect(last()).toEqual([{ kind: 'existing', id: 4 }])
    expect(screen.queryByLabelText('Search tags')).not.toBeInTheDocument()
  })

  it('creates a NEW tag from the search box', async () => {
    const { user, last } = setup([])
    await user.click(screen.getByRole('button', { name: '+ add tag' }))
    await user.type(screen.getByLabelText('Search tags'), 'Steuer')
    await user.click(screen.getByRole('button', { name: 'Create new tag “Steuer”' }))
    expect(last()).toEqual([{ kind: 'new', name: 'Steuer', nearest: expect.any(Array) }])
  })

  it('closes the search on Escape without changes', async () => {
    const { user, onChange } = setup([])
    await user.click(screen.getByRole('button', { name: '+ add tag' }))
    await user.type(screen.getByLabelText('Search tags'), 'x{Escape}')
    expect(screen.queryByLabelText('Search tags')).not.toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run web/src/TagEditor.test.tsx`
Expected: FAIL, because `./TagEditor` cannot be resolved.

- [ ] **Step 3: Implement `web/src/TagEditor.tsx`**

```tsx
import { useState } from 'react'
import type { NamedRef } from '../../src/api/types'
import { addExistingTag, addNewTag, removeTagAt, replaceNewTag, type TagEntry } from './editState'

interface Props {
  value: TagEntry[]
  options: NamedRef[]
  onChange(next: TagEntry[]): void
}

const MAX_RESULTS = 8

export function TagEditor({ value, options, onChange }: Props) {
  const [adding, setAdding] = useState(false)
  const [query, setQuery] = useState('')
  const nameOf = (id: number) => options.find((o) => o.id === id)?.name ?? `#${id}`
  const selected = new Set(value.flatMap((t) => (t.kind === 'existing' ? [t.id] : [])))
  const q = query.trim().toLowerCase()
  const matches = options.filter((o) => !selected.has(o.id) && o.name.toLowerCase().includes(q)).slice(0, MAX_RESULTS)
  const exact = options.some((o) => o.name.toLowerCase() === q)

  const close = () => {
    setAdding(false)
    setQuery('')
  }
  const pick = (id: number) => {
    onChange(addExistingTag(value, id))
    close()
  }
  const create = () => {
    onChange(addNewTag(value, query, options))
    close()
  }

  return (
    <div>
      <div className="mb-1 text-xs uppercase tracking-wide text-gray-500">Tags</div>
      <ul className="flex flex-wrap items-start gap-2">
        {value.map((t, i) =>
          t.kind === 'existing' ? (
            <li key={`e${t.id}`} className="flex flex-col">
              <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 py-1 pl-3 pr-1 text-sm text-blue-900">
                <span>{nameOf(t.id)}</span>
                <button
                  type="button"
                  aria-label={`Remove ${nameOf(t.id)}`}
                  onClick={() => onChange(removeTagAt(value, i))}
                  className="rounded-full px-2 leading-none hover:bg-blue-200"
                >
                  ×
                </button>
              </span>
              {t.matchedFrom && <span className="pl-3 text-xs text-gray-500">matched from “{t.matchedFrom}”</span>}
            </li>
          ) : (
            <li key={`n${t.name}`} className="flex max-w-full flex-col gap-1">
              <span className="inline-flex items-center gap-1 self-start rounded-full border-2 border-dashed border-amber-600 py-0.5 pl-3 pr-1 text-sm text-amber-700">
                <span>NEW: {t.name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${t.name}`}
                  onClick={() => onChange(removeTagAt(value, i))}
                  className="rounded-full px-2 leading-none hover:bg-amber-100"
                >
                  ×
                </button>
              </span>
              {t.nearest.length > 0 && (
                <span className="pl-3 text-xs text-amber-700">
                  “{t.name}” doesn't exist yet. Similar:{' '}
                  {t.nearest.map((n) => (
                    <button
                      key={n.id}
                      type="button"
                      aria-label={`Use ${n.name} instead of ${t.name}`}
                      onClick={() => onChange(replaceNewTag(value, i, n.id))}
                      className="mr-2 py-1 underline"
                    >
                      {n.name}
                    </button>
                  ))}
                </span>
              )}
            </li>
          ),
        )}
        {!adding && (
          <li>
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="rounded-full border border-gray-300 px-3 py-1 text-sm text-gray-600"
            >
              + add tag
            </button>
          </li>
        )}
      </ul>
      {adding && (
        <div className="mt-2" data-no-enter-apply>
          <input
            autoFocus
            aria-label="Search tags"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                close()
              } else if (e.key === 'Enter') {
                e.preventDefault()
                if (matches[0]) pick(matches[0].id)
                else if (q && !exact) create()
              }
            }}
            className="w-full rounded border border-gray-300 px-2 py-2"
          />
          <ul className="mt-1 max-h-60 overflow-y-auto rounded border border-gray-200">
            {matches.map((o) => (
              <li key={o.id}>
                <button type="button" onClick={() => pick(o.id)} className="w-full px-3 py-2 text-left hover:bg-gray-100">
                  {o.name}
                </button>
              </li>
            ))}
            {q && !exact && (
              <li>
                <button type="button" onClick={create} className="w-full px-3 py-2 text-left text-amber-700 hover:bg-amber-50">
                  Create new tag “{query.trim()}”
                </button>
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run web/src/TagEditor.test.tsx`
Expected: 6 tests PASS.

- [ ] **Step 5: Write the failing test `web/src/CorrespondentPicker.test.tsx`**

```tsx
// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { CorrespondentPicker } from './CorrespondentPicker'
import type { CorrespondentEntry } from './editState'
import { makeDetail } from './test/fixtures'

const options = makeDetail().vocabulary.correspondents

function setup(initial: CorrespondentEntry) {
  const onChange = vi.fn()
  function Harness() {
    const [value, setValue] = useState(initial)
    return (
      <CorrespondentPicker
        value={value}
        options={options}
        onChange={(next) => {
          setValue(next)
          onChange(next)
        }}
      />
    )
  }
  render(<Harness />)
  return { user: userEvent.setup(), last: () => onChange.mock.calls.at(-1)?.[0] as CorrespondentEntry }
}

describe('CorrespondentPicker', () => {
  it('selects existing correspondents or none', async () => {
    const { user, last } = setup({ kind: 'existing', id: 10 })
    expect(screen.getByLabelText('Correspondent')).toHaveValue('10')
    await user.selectOptions(screen.getByLabelText('Correspondent'), '11')
    expect(last()).toEqual({ kind: 'existing', id: 11 })
    await user.selectOptions(screen.getByLabelText('Correspondent'), '')
    expect(last()).toBeNull()
  })

  it('shows a match note', () => {
    setup({ kind: 'existing', id: 10, matchedFrom: 'Telekom' })
    expect(screen.getByText(/matched from “Telekom”/)).toBeInTheDocument()
  })

  it('creates a new correspondent and offers similar existing ones', async () => {
    const { user, last } = setup(null)
    await user.selectOptions(screen.getByLabelText('Correspondent'), 'Create new…')
    await user.type(screen.getByLabelText('New correspondent name'), 'Telekom')
    expect(last()).toMatchObject({ kind: 'new', name: 'Telekom' })
    await user.click(screen.getByRole('button', { name: 'Use Deutsche Telekom AG instead' }))
    expect(last()).toEqual({ kind: 'existing', id: 10 })
  })

  it('renders a proposed correspondent as NEW with alternatives', () => {
    setup({ kind: 'new', name: 'Telekom Deutschland', nearest: [{ id: 10, name: 'Deutsche Telekom AG', score: 0.8 }] })
    expect(screen.getByLabelText('New correspondent name')).toHaveValue('Telekom Deutschland')
    expect(screen.getByRole('button', { name: 'Use Deutsche Telekom AG instead' })).toBeInTheDocument()
  })
})
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run web/src/CorrespondentPicker.test.tsx`
Expected: FAIL, because `./CorrespondentPicker` cannot be resolved.

- [ ] **Step 7: Implement `web/src/CorrespondentPicker.tsx`**

```tsx
import type { NamedRef } from '../../src/api/types'
import { rankMatches } from '../../src/suggest/normalize'
import type { CorrespondentEntry } from './editState'

interface Props {
  value: CorrespondentEntry
  options: NamedRef[]
  onChange(next: CorrespondentEntry): void
}

const NEW = '__new__'

export function CorrespondentPicker({ value, options, onChange }: Props) {
  const sorted = [...options].sort((a, b) => a.name.localeCompare(b.name))
  const selectValue = value === null ? '' : value.kind === 'existing' ? String(value.id) : NEW
  const isNew = value?.kind === 'new'

  return (
    <div>
      <label className="block">
        <span className="mb-1 block text-xs uppercase tracking-wide text-gray-500">Correspondent</span>
        <select
          aria-label="Correspondent"
          value={selectValue}
          onChange={(e) => {
            const v = e.target.value
            if (v === '') onChange(null)
            else if (v === NEW) onChange({ kind: 'new', name: '', nearest: [] })
            else onChange({ kind: 'existing', id: Number(v) })
          }}
          className={`w-full rounded border bg-white px-2 py-2 ${isNew ? 'border-2 border-dashed border-amber-600' : 'border-gray-300'}`}
        >
          <option value="">— none —</option>
          {sorted.map((o) => (
            <option key={o.id} value={String(o.id)}>
              {o.name}
            </option>
          ))}
          <option value={NEW}>Create new…</option>
        </select>
      </label>
      {value?.kind === 'existing' && value.matchedFrom && (
        <p className="mt-1 text-xs text-gray-500">matched from “{value.matchedFrom}”</p>
      )}
      {value?.kind === 'new' && (
        <div className="mt-2 rounded border-2 border-dashed border-amber-600 p-2">
          <label className="block text-xs font-medium text-amber-700">
            NEW correspondent
            <input
              aria-label="New correspondent name"
              value={value.name}
              onChange={(e) =>
                onChange({ kind: 'new', name: e.target.value, nearest: rankMatches(e.target.value, options) })
              }
              className="mt-1 w-full rounded border border-gray-300 px-2 py-2 text-sm text-gray-900"
            />
          </label>
          {value.nearest.length > 0 && (
            <p className="mt-1 text-xs text-amber-700">
              Similar:{' '}
              {value.nearest.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  aria-label={`Use ${n.name} instead`}
                  onClick={() => onChange({ kind: 'existing', id: n.id })}
                  className="mr-2 py-1 underline"
                >
                  {n.name}
                </button>
              ))}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 8: Run tests and typecheck**

Run: `npx vitest run web/src && npm run typecheck`
Expected: all PASS; `tsc` exits 0.

- [ ] **Step 9: Commit**

```bash
git add web/src/TagEditor.tsx web/src/TagEditor.test.tsx web/src/CorrespondentPicker.tsx web/src/CorrespondentPicker.test.tsx
git commit -m "feat: tag editor and correspondent picker with NEW-entry alternatives" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Review screen, status bar, login and app shell

**Files:**
- Create: `web/src/Preview.tsx`, `web/src/StatusBar.tsx`, `web/src/EmptyState.tsx`, `web/src/Login.tsx`, `web/src/ReviewScreen.tsx`, `web/src/App.tsx`, `web/src/main.tsx`
- Test: `web/src/ReviewScreen.test.tsx`, `web/src/App.test.tsx`

**Interfaces:**
- Consumes: `api`, `ApiError`, `UnauthorizedError`, `fileUrl` (Task 13); edit-state functions (Task 13); `TagEditor`, `CorrespondentPicker` (Task 14); `ApplyConflict`, `DocumentDetail` (Task 12)
- Produces: `App` (root component) and `ReviewScreen`. Query keys: `['status']`, `['next', afterId | null]`, `['doc', id]`. Button names: `Skip`, `Regenerate`, `Apply & next` (on desktop the name also includes the key hint, so tests match with `/^Apply/`). Title input label: `Title`. Shortcuts: Enter = apply, S = skip, R = regenerate; S and R are ignored while typing in a field.

- [ ] **Step 1: Write the failing test `web/src/ReviewScreen.test.tsx`**

```tsx
// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from './api'
import { ReviewScreen } from './ReviewScreen'
import { makeDetail, makeStatus } from './test/fixtures'

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>()
  return {
    ...actual,
    api: { login: vi.fn(), status: vi.fn(), nextDocument: vi.fn(), document: vi.fn(), apply: vi.fn(), regenerate: vi.fn() },
  }
})
const mocked = vi.mocked(api)

function renderScreen() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <ReviewScreen />
    </QueryClientProvider>,
  )
  return userEvent.setup()
}

beforeEach(() => {
  vi.resetAllMocks()
  mocked.status.mockResolvedValue(makeStatus())
  mocked.nextDocument.mockImplementation(async (after?: number) => ({
    documentId: after === undefined ? 1 : after === 1 ? 2 : null,
  }))
  mocked.document.mockImplementation(async (id: number) => makeDetail({ id }))
  mocked.apply.mockResolvedValue({ status: 'applied' })
  mocked.regenerate.mockResolvedValue({ status: 'pending' })
})

describe('ReviewScreen', () => {
  it('shows the suggestion with the original title struck through', async () => {
    renderScreen()
    expect(await screen.findByDisplayValue('Telekom Rechnung 1')).toBeInTheDocument()
    expect(screen.getByText('scan_1')).toHaveClass('line-through')
    expect(screen.getByLabelText('Correspondent')).toHaveValue('10')
    expect(screen.getByText('Rechnung')).toBeInTheDocument()
    expect(screen.getByText('NEW: Mobilfunk')).toBeInTheDocument()
  })

  it('applies with Enter and moves to the next document', async () => {
    const user = renderScreen()
    await screen.findByDisplayValue('Telekom Rechnung 1')
    await user.keyboard('{Enter}')
    expect(await screen.findByDisplayValue('Telekom Rechnung 2')).toBeInTheDocument()
    expect(mocked.apply).toHaveBeenCalledWith(1, {
      title: 'Telekom Rechnung 1',
      correspondent: { id: 10 },
      tags: [{ id: 2 }, { name: 'Mobilfunk' }],
      expectedModified: '2026-09-14T10:00:01+02:00',
    })
  })

  it('skips with S without applying', async () => {
    const user = renderScreen()
    await screen.findByDisplayValue('Telekom Rechnung 1')
    await user.keyboard('s')
    expect(await screen.findByDisplayValue('Telekom Rechnung 2')).toBeInTheDocument()
    expect(mocked.apply).not.toHaveBeenCalled()
  })

  it('ignores S and R while typing in the title', async () => {
    const user = renderScreen()
    const title = await screen.findByDisplayValue('Telekom Rechnung 1')
    await user.type(title, ' sr')
    expect(title).toHaveValue('Telekom Rechnung 1 sr')
    expect(screen.queryByDisplayValue('Telekom Rechnung 2')).not.toBeInTheDocument()
    expect(mocked.regenerate).not.toHaveBeenCalled()
  })

  it('requests a new suggestion with R', async () => {
    const user = renderScreen()
    await screen.findByDisplayValue('Telekom Rechnung 1')
    await user.keyboard('r')
    expect(mocked.regenerate).toHaveBeenCalledWith(1)
  })

  it('applies the edited state after swapping a NEW tag', async () => {
    const user = renderScreen()
    await screen.findByDisplayValue('Telekom Rechnung 1')
    await user.click(screen.getByRole('button', { name: 'Use Telefon/Internet instead of Mobilfunk' }))
    await user.click(screen.getByRole('button', { name: /^Apply/ }))
    expect(mocked.apply).toHaveBeenCalledWith(1, expect.objectContaining({ tags: [{ id: 2 }, { id: 3 }] }))
  })

  it('turns deleted tags into NEW chips on a missing-entity conflict', async () => {
    mocked.apply.mockRejectedValueOnce(
      new ApiError('conflict', 409, { reason: 'missing', missingTagIds: [2], missingCorrespondentId: null }),
    )
    const user = renderScreen()
    await screen.findByDisplayValue('Telekom Rechnung 1')
    await user.click(screen.getByRole('button', { name: /^Apply/ }))
    expect(await screen.findByText(/deleted in Paperless/)).toBeInTheDocument()
    expect(screen.getByText('NEW: Rechnung')).toBeInTheDocument()
  })

  it('warns and offers a reload when the document changed in Paperless', async () => {
    mocked.apply.mockRejectedValueOnce(new ApiError('conflict', 409, { reason: 'modified', current: {} }))
    const user = renderScreen()
    await screen.findByDisplayValue('Telekom Rechnung 1')
    await user.click(screen.getByRole('button', { name: /^Apply/ }))
    expect(await screen.findByText(/changed in Paperless/)).toBeInTheDocument()
    const calls = mocked.document.mock.calls.filter(([id]) => id === 1).length
    await user.click(screen.getByRole('button', { name: 'Reload' }))
    await vi.waitFor(() => expect(mocked.document.mock.calls.filter(([id]) => id === 1).length).toBeGreaterThan(calls))
  })

  it('shows the empty state with waiting count', async () => {
    mocked.nextDocument.mockResolvedValue({ documentId: null })
    renderScreen()
    expect(await screen.findByText('Nothing to review right now')).toBeInTheDocument()
    expect(await screen.findByText(/3 documents waiting for the LLM/)).toBeInTheDocument()
  })

  it('shows the error reason and falls back to current values', async () => {
    mocked.document.mockResolvedValue(
      makeDetail({ id: 1, suggestion: { status: 'error', error: 'Invalid model output after 2 attempts', title: null } }),
    )
    renderScreen()
    expect(await screen.findByText(/Invalid model output after 2 attempts/)).toBeInTheDocument()
    expect(screen.getByLabelText('Title')).toHaveValue('scan_1')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run web/src/ReviewScreen.test.tsx`
Expected: FAIL, because `./ReviewScreen` cannot be resolved.

- [ ] **Step 3: Implement `web/src/Preview.tsx`**

```tsx
import { useState } from 'react'
import { fileUrl } from './api'

export function Preview({ id, content }: { id: number; content: string }) {
  const [showText, setShowText] = useState(false)
  return (
    <section className="flex flex-col bg-gray-100 desk:w-1/2">
      <div className="flex gap-4 px-3 py-2 text-sm">
        <button type="button" onClick={() => setShowText((v) => !v)} className="underline">
          {showText ? 'Show document' : 'Show OCR text'}
        </button>
        <a href={fileUrl(id, 'preview')} target="_blank" rel="noreferrer" className="underline">
          Open PDF ↗
        </a>
      </div>
      {showText ? (
        <pre className="max-h-72 flex-1 overflow-auto whitespace-pre-wrap p-3 text-xs desk:max-h-none">{content}</pre>
      ) : (
        <>
          <iframe title="Document preview" src={fileUrl(id, 'preview')} className="hidden w-full flex-1 bg-white desk:block" />
          <a href={fileUrl(id, 'preview')} target="_blank" rel="noreferrer" className="flex justify-center p-3 desk:hidden">
            <img src={fileUrl(id, 'thumb')} alt="Document thumbnail" className="max-h-56 bg-white shadow" />
          </a>
        </>
      )}
    </section>
  )
}
```

- [ ] **Step 4: Implement `web/src/StatusBar.tsx`**

```tsx
import { useQuery } from '@tanstack/react-query'
import { api } from './api'

export function StatusBar() {
  const { data } = useQuery({ queryKey: ['status'], queryFn: api.status, refetchInterval: 15_000 })
  return (
    <>
      <header className="flex h-12 items-center justify-between gap-2 border-b border-gray-200 px-3 text-sm">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="font-semibold">Paperless Suggest</span>
          {data && (
            <span className="truncate text-gray-500">
              {data.counts.ready} ready · {data.counts.pending} waiting for LLM
              {data.counts.error > 0 ? ` · ${data.counts.error} failed` : ''}
            </span>
          )}
        </div>
        {data && (
          <div className="flex shrink-0 items-center gap-1.5">
            <span aria-hidden className={`h-2 w-2 rounded-full ${data.llm.ok ? 'bg-green-600' : 'bg-gray-400'}`} />
            <span className="hidden sm:inline">{data.llm.ok ? `LM Studio · ${data.llm.model}` : 'LLM offline'}</span>
            <span className="sm:hidden">{data.llm.ok ? 'LLM' : 'LLM off'}</span>
          </div>
        )}
      </header>
      {data && !data.paperless.ok && data.paperless.error && (
        <div role="alert" className="bg-red-50 px-3 py-2 text-sm text-red-800">
          Paperless unreachable: {data.paperless.error}
        </div>
      )}
    </>
  )
}
```

- [ ] **Step 5: Implement `web/src/EmptyState.tsx`**

```tsx
import { useQuery } from '@tanstack/react-query'
import { api } from './api'

export function EmptyState({ onRefresh }: { onRefresh: () => void }) {
  const { data } = useQuery({ queryKey: ['status'], queryFn: api.status })
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-lg font-medium">Nothing to review right now</p>
      {data && (
        <p className="text-sm text-gray-600">
          {data.counts.pending} document{data.counts.pending === 1 ? '' : 's'} waiting for the LLM · LLM{' '}
          {data.llm.ok ? 'online' : 'offline'}
        </p>
      )}
      <button type="button" onClick={onRefresh} className="rounded border border-gray-300 px-4 py-2">
        Check again
      </button>
    </div>
  )
}
```

- [ ] **Step 6: Implement `web/src/ReviewScreen.tsx`**

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { ApplyConflict, DocumentDetail } from '../../src/api/types'
import { api, ApiError } from './api'
import { CorrespondentPicker } from './CorrespondentPicker'
import { applyMissing, canApply, initialEditState, toApplyRequest, type EditState } from './editState'
import { EmptyState } from './EmptyState'
import { Preview } from './Preview'
import { TagEditor } from './TagEditor'

export function ReviewScreen() {
  const qc = useQueryClient()
  const [after, setAfter] = useState<number | null>(null)
  const next = useQuery({ queryKey: ['next', after], queryFn: () => api.nextDocument(after ?? undefined) })
  const id = next.data?.documentId ?? null
  const detail = useQuery({
    queryKey: ['doc', id],
    queryFn: () => api.document(id as number),
    enabled: id !== null,
    refetchInterval: (q) => (q.state.data?.suggestion?.status === 'pending' ? 3000 : false),
  })

  // Prefetch the following document so moving on is instant.
  useEffect(() => {
    if (id === null) return
    qc.fetchQuery({ queryKey: ['next', id], queryFn: () => api.nextDocument(id) })
      .then(({ documentId }) => {
        if (documentId !== null) {
          void qc.prefetchQuery({ queryKey: ['doc', documentId], queryFn: () => api.document(documentId) })
        }
      })
      .catch(() => {})
  }, [id, qc])

  if (next.isPending) return <Centered>Loading…</Centered>
  if (next.isError) return <Centered>{next.error.message}</Centered>
  if (id === null) {
    return (
      <EmptyState
        onRefresh={() => {
          setAfter(null)
          void qc.invalidateQueries({ queryKey: ['next'] })
        }}
      />
    )
  }
  if (detail.isPending) return <Centered>Loading…</Centered>
  if (detail.isError) return <Centered>{detail.error.message}</Centered>

  const d = detail.data
  return (
    <ReviewForm
      key={`${d.document.id}:${d.suggestion?.updatedAt ?? ''}:${d.document.modified}`}
      detail={d}
      onNext={() => {
        setAfter(d.document.id)
        void qc.invalidateQueries({ queryKey: ['status'] })
      }}
      onReload={() => void qc.invalidateQueries({ queryKey: ['doc', d.document.id] })}
    />
  )
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex min-h-[60vh] items-center justify-center p-6 text-gray-600">{children}</div>
}

type Tone = 'error' | 'warn' | 'info'
const TONES: Record<Tone, string> = {
  error: 'border-red-200 bg-red-50 text-red-800',
  warn: 'border-amber-200 bg-amber-50 text-amber-900',
  info: 'border-blue-200 bg-blue-50 text-blue-900',
}

function Banner({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <div role={tone === 'info' ? 'status' : 'alert'} className={`rounded border px-3 py-2 text-sm ${TONES[tone]}`}>
      {children}
    </div>
  )
}

const secondaryButton = 'flex-1 rounded border border-gray-300 px-3 py-3 text-sm desk:flex-none desk:py-2'
const primaryButton =
  'flex-[2] rounded bg-blue-600 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50 desk:flex-none desk:py-2'
const kbd = 'ml-1 hidden font-mono text-xs opacity-70 desk:inline'

interface Notice {
  kind: 'modified' | 'missing' | 'failed'
  text: string
}

function ReviewForm({ detail, onNext, onReload }: { detail: DocumentDetail; onNext: () => void; onReload: () => void }) {
  const qc = useQueryClient()
  const doc = detail.document
  const s = detail.suggestion
  const [edit, setEdit] = useState<EditState>(() => initialEditState(detail))
  const [notice, setNotice] = useState<Notice | null>(null)

  const apply = useMutation({
    mutationFn: (state: EditState) => api.apply(doc.id, toApplyRequest(state, doc.modified)),
    onSuccess: onNext,
    onError: (e) => {
      if (e instanceof ApiError && e.status === 409) {
        const conflict = e.body as ApplyConflict
        if (conflict.reason === 'missing') {
          setEdit((st) => applyMissing(st, conflict, detail.vocabulary))
          setNotice({
            kind: 'missing',
            text: 'Some tags or the correspondent were deleted in Paperless. They are now marked NEW — confirm or remove them, then apply again.',
          })
        } else {
          setNotice({ kind: 'modified', text: 'This document was changed in Paperless after you opened it.' })
        }
      } else {
        setNotice({ kind: 'failed', text: `Apply failed: ${e.message}` })
      }
    },
  })
  const regenerate = useMutation({
    mutationFn: () => api.regenerate(doc.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['doc', doc.id] }),
  })

  const submit = useCallback(() => {
    if (canApply(edit) && !apply.isPending) apply.mutate(edit)
  }, [edit, apply])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return
      const target = e.target instanceof Element ? e.target : null
      if (e.key === 'Enter') {
        if (target?.closest('button, a, textarea, [data-no-enter-apply]')) return
        e.preventDefault()
        submit()
        return
      }
      if (target?.closest('input, textarea, select')) return
      if (e.key === 's' || e.key === 'S') {
        e.preventDefault()
        onNext()
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault()
        regenerate.mutate()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [submit, onNext, regenerate])

  return (
    <div className="flex flex-col desk:h-[calc(100dvh-3rem)] desk:flex-row">
      <Preview id={doc.id} content={doc.content} />
      <div className="flex-1 space-y-5 overflow-y-auto p-4 pb-28 desk:pb-4">
        {s?.status === 'error' && <Banner tone="error">Suggestion failed: {s.error}</Banner>}
        {s?.status === 'no_text' && (
          <Banner tone="warn">This document has no OCR text, so there is no suggestion. Fill in the fields yourself.</Banner>
        )}
        {s?.status === 'pending' && <Banner tone="info">Generating a new suggestion…</Banner>}
        {notice && (
          <Banner tone={notice.kind === 'failed' ? 'error' : 'warn'}>
            {notice.text}
            {notice.kind === 'modified' && (
              <button type="button" onClick={onReload} className="ml-2 underline">
                Reload
              </button>
            )}
          </Banner>
        )}

        <div>
          <label htmlFor="title" className="mb-1 block text-xs uppercase tracking-wide text-gray-500">
            Title
          </label>
          <input
            id="title"
            value={edit.title}
            onChange={(e) => setEdit((st) => ({ ...st, title: e.target.value }))}
            className="w-full rounded border border-gray-300 px-2 py-2"
          />
          {doc.title !== edit.title && <span className="mt-1 block text-xs text-gray-400 line-through">{doc.title}</span>}
        </div>

        <CorrespondentPicker
          value={edit.correspondent}
          options={detail.vocabulary.correspondents}
          onChange={(correspondent) => setEdit((st) => ({ ...st, correspondent }))}
        />
        <TagEditor
          value={edit.tags}
          options={detail.vocabulary.tags}
          onChange={(tags) => setEdit((st) => ({ ...st, tags }))}
        />

        <p className="text-xs text-gray-500">
          Inbox tag will be removed on apply.{s?.model ? ` Suggested by ${s.model}.` : ''}
        </p>

        <div className="fixed inset-x-0 bottom-0 flex gap-2 border-t border-gray-200 bg-white p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] desk:static desk:border-0 desk:p-0">
          <button type="button" onClick={onNext} className={secondaryButton}>
            Skip<kbd className={kbd}>S</kbd>
          </button>
          <button type="button" onClick={() => regenerate.mutate()} disabled={regenerate.isPending} className={secondaryButton}>
            Regenerate<kbd className={kbd}>R</kbd>
          </button>
          <button type="button" onClick={submit} disabled={!canApply(edit) || apply.isPending} className={primaryButton}>
            Apply &amp; next<kbd className={kbd}>⏎</kbd>
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 7: Run the ReviewScreen test to verify it passes**

Run: `npx vitest run web/src/ReviewScreen.test.tsx`
Expected: 10 tests PASS.

- [ ] **Step 8: Write the failing test `web/src/App.test.tsx`**

```tsx
// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api, UnauthorizedError } from './api'
import { App } from './App'
import { makeStatus } from './test/fixtures'

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>()
  return {
    ...actual,
    api: { login: vi.fn(), status: vi.fn(), nextDocument: vi.fn(), document: vi.fn(), apply: vi.fn(), regenerate: vi.fn() },
  }
})
const mocked = vi.mocked(api)

let authed = false
beforeEach(() => {
  vi.resetAllMocks()
  authed = false
  mocked.status.mockImplementation(async () => {
    if (!authed) throw new UnauthorizedError()
    return makeStatus()
  })
  mocked.nextDocument.mockImplementation(async () => {
    if (!authed) throw new UnauthorizedError()
    return { documentId: null }
  })
})

describe('App', () => {
  it('asks for the password on 401 and continues after signing in', async () => {
    mocked.login.mockImplementation(async () => {
      authed = true
      return { ok: true }
    })
    const user = userEvent.setup()
    render(<App />)
    await user.type(await screen.findByLabelText('Password'), 'pw')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText('Nothing to review right now')).toBeInTheDocument()
    expect(await screen.findByText(/2 ready · 3 waiting for LLM/)).toBeInTheDocument()
    expect(mocked.login).toHaveBeenCalledWith('pw')
  })

  it('shows a wrong-password message', async () => {
    mocked.login.mockRejectedValue(new UnauthorizedError())
    const user = userEvent.setup()
    render(<App />)
    await user.type(await screen.findByLabelText('Password'), 'nope')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText('Wrong password')).toBeInTheDocument()
  })
})
```

- [ ] **Step 9: Implement `web/src/Login.tsx`**

```tsx
import { useState, type FormEvent } from 'react'
import { api, ApiError, UnauthorizedError } from './api'

export function Login({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.login(password)
      onSuccess()
    } catch (err) {
      setError(
        err instanceof UnauthorizedError
          ? 'Wrong password'
          : err instanceof ApiError && err.status === 429
            ? 'Too many attempts, try again later'
            : 'Login failed',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="mx-auto mt-24 flex max-w-xs flex-col gap-3 p-4">
      <h1 className="text-xl font-semibold">Paperless Suggest</h1>
      <input
        type="password"
        aria-label="Password"
        autoComplete="current-password"
        autoFocus
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="rounded border border-gray-300 px-3 py-2"
      />
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={busy || !password}
        className="rounded bg-blue-600 px-4 py-2 font-semibold text-white disabled:opacity-50"
      >
        Sign in
      </button>
    </form>
  )
}
```

- [ ] **Step 10: Implement `web/src/App.tsx` and `web/src/main.tsx`**

`web/src/App.tsx`:
```tsx
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { UnauthorizedError } from './api'
import { Login } from './Login'
import { ReviewScreen } from './ReviewScreen'
import { StatusBar } from './StatusBar'

export function App() {
  const [needsLogin, setNeedsLogin] = useState(false)
  const [client] = useState(() => {
    const onError = (e: unknown) => {
      if (e instanceof UnauthorizedError) setNeedsLogin(true)
    }
    return new QueryClient({
      queryCache: new QueryCache({ onError }),
      mutationCache: new MutationCache({ onError }),
      defaultOptions: {
        queries: {
          retry: (count, e) => !(e instanceof UnauthorizedError) && count < 2,
          refetchOnWindowFocus: false,
        },
      },
    })
  })

  return (
    <QueryClientProvider client={client}>
      {needsLogin ? (
        <Login
          onSuccess={() => {
            setNeedsLogin(false)
            void client.resetQueries()
          }}
        />
      ) : (
        <div className="min-h-dvh bg-white text-gray-900">
          <StatusBar />
          <ReviewScreen />
        </div>
      )}
    </QueryClientProvider>
  )
}
```

`web/src/main.tsx`:
```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

- [ ] **Step 11: Run all web tests, the typecheck and a production build**

Run: `npx vitest run web/src && npm run typecheck && npx vite build --config web/vite.config.ts`
Expected: all tests PASS; `tsc` exits 0; Vite writes `dist/web/index.html` and `dist/web/assets/*.js|css`.

- [ ] **Step 12: Commit**

```bash
git add web/src
git commit -m "feat: review screen with keyboard shortcuts, status bar and login" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: End-to-end test on desktop and mobile

**Files:**
- Create: `playwright.config.ts`, `e2e/review.spec.ts`
- Note: `vitest.config.ts` stays as is; its `include` patterns already leave `e2e/` to Playwright.

**Interfaces:**
- Consumes: the web app (Tasks 13–15), served by the Vite dev server. The API is mocked with `page.route`, so no backend is needed.
- Produces: `npm run test:e2e`

- [ ] **Step 1: Install Playwright and Chromium**

Run:
```bash
npm i -D @playwright/test
npx playwright install chromium
```
Expected: Chromium is downloaded to `~/.cache/ms-playwright/`.

- [ ] **Step 2: Create `playwright.config.ts`**

```ts
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  use: { baseURL: 'http://localhost:5174' },
  webServer: {
    command: 'npx vite --config web/vite.config.ts --port 5174 --strictPort',
    url: 'http://localhost:5174',
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    { name: 'mobile', use: { ...devices['iPhone 13'], browserName: 'chromium' } },
  ],
})
```

- [ ] **Step 3: Write `e2e/review.spec.ts`**

```ts
import { expect, test, type Page } from '@playwright/test'

const vocabulary = {
  inboxTagId: 1,
  tags: [
    { id: 2, name: 'Rechnung' },
    { id: 3, name: 'Telefon/Internet' },
  ],
  correspondents: [{ id: 10, name: 'Deutsche Telekom AG' }],
}

const detail = (id: number) => ({
  document: {
    id,
    title: `scan_${id}`,
    content: `OCR text ${id} `.repeat(200),
    correspondentId: null,
    tagIds: [1],
    modified: `m${id}`,
    added: 'a',
  },
  suggestion: {
    documentId: id,
    status: 'ready',
    title: `Telekom Rechnung ${id}`,
    correspondentId: 10,
    proposedCorrespondent: null,
    tagIds: [2],
    proposedTags: [{ name: 'Mobilfunk', nearest: [{ id: 3, name: 'Telefon/Internet', score: 0.4 }] }],
    matchedNotes: {},
    model: 'qwen3-14b',
    error: null,
    docModified: `m${id}`,
    updatedAt: 'u',
  },
  vocabulary,
})

async function mockApi(page: Page) {
  const applied: unknown[] = []
  await page.route('**/api/status', (r) =>
    r.fulfill({
      json: {
        paperless: { ok: true, error: null },
        llm: { ok: true, model: 'qwen3-14b', error: null },
        lastPollAt: 'x',
        counts: { ready: 2, pending: 0, error: 0, noText: 0 },
      },
    }),
  )
  await page.route('**/api/queue/next**', (r) => {
    const after = new URL(r.request().url()).searchParams.get('after')
    r.fulfill({ json: { documentId: after === null ? 1 : after === '1' ? 2 : null } })
  })
  await page.route(/\/api\/documents\/\d+$/, (r) => {
    const id = Number(new URL(r.request().url()).pathname.split('/').pop())
    r.fulfill({ json: detail(id) })
  })
  await page.route(/\/api\/documents\/\d+\/thumb$/, (r) =>
    r.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="140"/>' }),
  )
  await page.route(/\/api\/documents\/\d+\/preview$/, (r) => r.fulfill({ contentType: 'text/html', body: '<p>PDF</p>' }))
  await page.route(/\/api\/documents\/\d+\/apply$/, (r) => {
    applied.push(r.request().postDataJSON())
    r.fulfill({ json: { status: 'applied' } })
  })
  return applied
}

test('apply & next walks through the inbox', async ({ page }) => {
  const applied = await mockApi(page)
  await page.goto('/')
  await expect(page.getByLabel('Title')).toHaveValue('Telekom Rechnung 1')
  await page.getByRole('button', { name: 'Use Telefon/Internet instead of Mobilfunk' }).click()
  await page.getByRole('button', { name: /^Apply/ }).click()
  await expect(page.getByLabel('Title')).toHaveValue('Telekom Rechnung 2')
  expect(applied[0]).toEqual({
    title: 'Telekom Rechnung 1',
    correspondent: { id: 10 },
    tags: [{ id: 2 }, { id: 3 }],
    expectedModified: 'm1',
  })
})

test('Enter applies on desktop', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'keyboard shortcuts are a desktop feature')
  const applied = await mockApi(page)
  await page.goto('/')
  await expect(page.getByLabel('Title')).toHaveValue('Telekom Rechnung 1')
  await page.keyboard.press('Enter')
  await expect(page.getByLabel('Title')).toHaveValue('Telekom Rechnung 2')
  expect(applied).toHaveLength(1)
  await expect(page.getByTitle('Document preview')).toBeVisible()
})

test('action bar stays reachable on mobile', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'mobile layout only')
  await mockApi(page)
  await page.goto('/')
  await expect(page.getByLabel('Title')).toHaveValue('Telekom Rechnung 1')
  const apply = page.getByRole('button', { name: /^Apply/ })
  await expect(apply).toBeInViewport()
  await page.mouse.wheel(0, 3000)
  await expect(apply).toBeInViewport()
  await expect(page.getByAltText('Document thumbnail')).toBeVisible()
  await expect(page.getByTitle('Document preview')).toBeHidden()
})
```

- [ ] **Step 4: Run the e2e tests**

Run: `npm run test:e2e`
Expected: the desktop project runs 2 tests and skips 1; the mobile project runs 2 and skips 1. All run tests PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json playwright.config.ts e2e
git commit -m "test: end-to-end review flow on desktop and mobile" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 17: Evaluation metrics and HTML report

**Files:**
- Create: `src/eval/metrics.ts`, `src/eval/report.ts`
- Test: `tests/eval/metrics.test.ts`, `tests/eval/report.test.ts`

**Interfaces:**
- Consumes: `SuggestResult` (Task 5)
- Produces:
  ```ts
  // metrics.ts
  export interface GroundTruth { documentId: number; title: string; correspondentId: number; tagIds: number[]; content: string }
  export type EvalOutcome = SuggestResult | { kind: 'exception'; error: string }
  export interface EvalCase { truth: GroundTruth; outcome: EvalOutcome; seconds: number }
  export interface TitleChecks { lengthOk: boolean; languageOk: boolean; datesOk: boolean }
  export interface ModelSummary { model: string; documents: number; correspondentAccuracy: number; tagPrecision: number; tagRecall: number; tagF1: number; newNameRate: number; failureRate: number; titleChecksPassRate: number; avgSeconds: number }
  export function detectLanguage(text: string): 'de' | 'en' | 'unknown'
  export function checkTitle(title: string, content: string): TitleChecks
  export function summarize(model: string, cases: EvalCase[]): ModelSummary
  // report.ts
  export interface ReportCell { title: string | null; correspondent: string | null; tags: string[]; proposed: string[]; error: string | null; seconds: number; checks: TitleChecks | null }
  export interface ReportRow { documentId: number; truth: { title: string; correspondent: string; tags: string[] }; byModel: Record<string, ReportCell> }
  export function renderReport(input: { generatedAt: string; summaries: ModelSummary[]; rows: ReportRow[] }): string
  ```
  Metric definitions (all values are 0..1 except `avgSeconds`):
  - `correspondentAccuracy`: share of all cases where the suggested correspondent id equals the truth. Failed cases count as wrong.
  - `tagPrecision` / `tagRecall` / `tagF1`: micro-averaged over all cases, using existing tag ids only. Failed cases add nothing to "predicted" but count fully towards "truth".
  - `newNameRate`: share of successful cases that proposed at least one new tag or correspondent. The ground truth always uses existing names, so every proposal is unnecessary.
  - `failureRate`: share of cases with kind `error`, `exception` or `no_text`.
  - `titleChecksPassRate`: share of successful cases where all three title checks pass.

- [ ] **Step 1: Write the failing test `tests/eval/metrics.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { checkTitle, detectLanguage, summarize, type EvalCase } from '../../src/eval/metrics'

const truth = (id: number, correspondentId: number, tagIds: number[]) => ({
  documentId: id,
  title: 't',
  correspondentId,
  tagIds,
  content: 'Rechnung vom 14.09.2026 für September 2026',
})

const ok = (correspondentId: number | null, tagIds: number[], proposed = 0, title = 'Telekom Rechnung September 2026') => ({
  kind: 'ok' as const,
  suggestion: {
    title,
    correspondentId,
    proposedCorrespondent: null,
    tagIds,
    proposedTags: Array.from({ length: proposed }, (_, i) => ({ name: `new${i}`, nearest: [] })),
    matchedNotes: {},
    model: 'm',
  },
})

describe('detectLanguage', () => {
  it('detects German and English by common words', () => {
    expect(detectLanguage('Ihre Rechnung für den Monat')).toBe('de')
    expect(detectLanguage('Your invoice for the month')).toBe('en')
    expect(detectLanguage('Telekom 2026')).toBe('unknown')
  })
})

describe('checkTitle', () => {
  const content = 'Deutsche Telekom Rechnung vom 14.09.2026 für den Monat September'

  it('passes a good title', () => {
    expect(checkTitle('Telekom Rechnung September 2026', content)).toEqual({ lengthOk: true, languageOk: true, datesOk: true })
  })

  it('flags invented years, dates and months', () => {
    expect(checkTitle('Telekom Rechnung 2025', content).datesOk).toBe(false)
    expect(checkTitle('Telekom Rechnung 01.02.2026', content).datesOk).toBe(false)
    expect(checkTitle('Telekom Rechnung Oktober', content).datesOk).toBe(false)
  })

  it('accepts a month given numerically in the text', () => {
    expect(checkTitle('Telekom Rechnung Sep 2026', content).datesOk).toBe(true)
  })

  it('flags wrong language and bad length', () => {
    expect(checkTitle('Telekom invoice for September', content).languageOk).toBe(false)
    expect(checkTitle('x'.repeat(81), content).lengthOk).toBe(false)
    expect(checkTitle('ab', content).lengthOk).toBe(false)
  })
})

describe('summarize', () => {
  it('computes accuracy, micro P/R/F1, new-name and failure rates', () => {
    const cases: EvalCase[] = [
      { truth: truth(1, 10, [2, 3]), outcome: ok(10, [2]), seconds: 2 },
      { truth: truth(2, 11, [2]), outcome: ok(10, [2, 4], 1), seconds: 4 },
      { truth: truth(3, 12, [5]), outcome: { kind: 'error', error: 'bad', model: 'm' }, seconds: 6 },
      { truth: truth(4, 12, [5]), outcome: { kind: 'exception', error: 'down' }, seconds: 0 },
    ]
    const s = summarize('m', cases)
    expect(s.model).toBe('m')
    expect(s.documents).toBe(4)
    expect(s.correspondentAccuracy).toBe(0.25)
    // predicted: {2}, {2,4} -> 3; true positives: 2; truth total: 2 + 1 + 1 + 1 = 5
    expect(s.tagPrecision).toBeCloseTo(2 / 3)
    expect(s.tagRecall).toBeCloseTo(2 / 5)
    expect(s.tagF1).toBeCloseTo((2 * (2 / 3) * (2 / 5)) / (2 / 3 + 2 / 5))
    expect(s.newNameRate).toBe(0.5)
    expect(s.failureRate).toBe(0.5)
    expect(s.titleChecksPassRate).toBe(1)
    expect(s.avgSeconds).toBe(3)
  })

  it('handles an empty or all-failed run without NaN', () => {
    const s = summarize('m', [{ truth: truth(1, 10, [2]), outcome: { kind: 'no_text' }, seconds: 1 }])
    expect(s).toMatchObject({ tagPrecision: 0, tagRecall: 0, tagF1: 0, newNameRate: 0, failureRate: 1, titleChecksPassRate: 0 })
    expect(summarize('m', []).avgSeconds).toBe(0)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/eval/metrics.test.ts`
Expected: FAIL, because the module does not exist.

- [ ] **Step 3: Implement `src/eval/metrics.ts`**

```ts
import type { SuggestResult } from '../suggest/types'

export interface GroundTruth {
  documentId: number
  title: string
  correspondentId: number
  tagIds: number[]
  content: string
}

export type EvalOutcome = SuggestResult | { kind: 'exception'; error: string }

export interface EvalCase {
  truth: GroundTruth
  outcome: EvalOutcome
  seconds: number
}

export interface TitleChecks {
  lengthOk: boolean
  languageOk: boolean
  datesOk: boolean
}

export interface ModelSummary {
  model: string
  documents: number
  correspondentAccuracy: number
  tagPrecision: number
  tagRecall: number
  tagF1: number
  newNameRate: number
  failureRate: number
  titleChecksPassRate: number
  avgSeconds: number
}

const DE_WORDS = new Set([
  'der', 'die', 'das', 'und', 'ist', 'nicht', 'mit', 'für', 'von', 'vom', 'den', 'dem', 'des', 'ihre', 'ihr',
  'wir', 'zu', 'auf', 'im', 'ein', 'eine', 'bei', 'rechnung', 'vertrag', 'bescheid', 'kündigung', 'versicherung',
  'abrechnung', 'mahnung', 'lohnabrechnung', 'kontoauszug', 'monat', 'jahr',
])
const EN_WORDS = new Set([
  'the', 'and', 'is', 'not', 'with', 'for', 'of', 'to', 'your', 'we', 'you', 'on', 'in', 'a', 'an', 'at', 'from',
  'invoice', 'contract', 'statement', 'receipt', 'policy', 'letter', 'bill', 'month', 'year',
])

export function detectLanguage(text: string): 'de' | 'en' | 'unknown' {
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? []
  let de = 0
  let en = 0
  for (const w of words) {
    if (DE_WORDS.has(w)) de++
    if (EN_WORDS.has(w)) en++
  }
  if (de === en) return 'unknown'
  return de > en ? 'de' : 'en'
}

const MONTHS: [RegExp, number][] = [
  [/\b(januar|january|jan)\b/i, 1],
  [/\b(februar|february|feb)\b/i, 2],
  [/\b(märz|maerz|march|mar)\b/i, 3],
  [/\b(april|apr)\b/i, 4],
  [/\b(mai|may)\b/i, 5],
  [/\b(juni|june|jun)\b/i, 6],
  [/\b(juli|july|jul)\b/i, 7],
  [/\b(august|aug)\b/i, 8],
  [/\b(september|sept|sep)\b/i, 9],
  [/\b(oktober|october|okt|oct)\b/i, 10],
  [/\b(november|nov)\b/i, 11],
  [/\b(dezember|december|dez|dec)\b/i, 12],
]

function datesOk(title: string, content: string): boolean {
  for (const year of title.match(/\b(19|20)\d{2}\b/g) ?? []) if (!content.includes(year)) return false
  for (const date of title.match(/\b\d{1,2}\.\d{1,2}\.(\d{2,4})?/g) ?? []) if (!content.includes(date)) return false
  for (const [pattern, month] of MONTHS) {
    if (!pattern.test(title)) continue
    const numeric = new RegExp(`\\.0?${month}\\.`)
    if (!pattern.test(content) && !numeric.test(content)) return false
  }
  return true
}

export function checkTitle(title: string, content: string): TitleChecks {
  const t = detectLanguage(title)
  const c = detectLanguage(content)
  return {
    lengthOk: title.trim().length >= 3 && title.length <= 80,
    languageOk: t === 'unknown' || c === 'unknown' || t === c,
    datesOk: datesOk(title, content),
  }
}

const ratio = (a: number, b: number) => (b === 0 ? 0 : a / b)

export function summarize(model: string, cases: EvalCase[]): ModelSummary {
  let correct = 0
  let truePositives = 0
  let predicted = 0
  let truthTotal = 0
  let succeeded = 0
  let withProposals = 0
  let titlesOk = 0
  let seconds = 0
  for (const c of cases) {
    seconds += c.seconds
    truthTotal += c.truth.tagIds.length
    if (c.outcome.kind !== 'ok') continue
    const s = c.outcome.suggestion
    succeeded++
    if (s.correspondentId === c.truth.correspondentId) correct++
    predicted += s.tagIds.length
    truePositives += s.tagIds.filter((id) => c.truth.tagIds.includes(id)).length
    if (s.proposedCorrespondent || s.proposedTags.length > 0) withProposals++
    const checks = checkTitle(s.title, c.truth.content)
    if (checks.lengthOk && checks.languageOk && checks.datesOk) titlesOk++
  }
  const precision = ratio(truePositives, predicted)
  const recall = ratio(truePositives, truthTotal)
  return {
    model,
    documents: cases.length,
    correspondentAccuracy: ratio(correct, cases.length),
    tagPrecision: precision,
    tagRecall: recall,
    tagF1: ratio(2 * precision * recall, precision + recall),
    newNameRate: ratio(withProposals, succeeded),
    failureRate: ratio(cases.length - succeeded, cases.length),
    titleChecksPassRate: ratio(titlesOk, succeeded),
    avgSeconds: ratio(seconds, cases.length),
  }
}
```

- [ ] **Step 4: Run the metrics test to verify it passes**

Run: `npx vitest run tests/eval/metrics.test.ts`
Expected: 7 tests PASS.

- [ ] **Step 5: Write the failing test `tests/eval/report.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import type { ModelSummary } from '../../src/eval/metrics'
import { renderReport } from '../../src/eval/report'

const summary = (model: string, f1: number): ModelSummary => ({
  model,
  documents: 2,
  correspondentAccuracy: 0.5,
  tagPrecision: 0.8,
  tagRecall: 0.6,
  tagF1: f1,
  newNameRate: 0.1,
  failureRate: 0,
  titleChecksPassRate: 1,
  avgSeconds: 3.25,
})

describe('renderReport', () => {
  const html = renderReport({
    generatedAt: '2026-09-29T10:00:00Z',
    summaries: [summary('qwen3-14b', 0.7), summary('gemma-3-12b', 0.65)],
    rows: [
      {
        documentId: 7,
        truth: { title: 'Rechnung <Telekom>', correspondent: 'Deutsche Telekom AG', tags: ['Rechnung'] },
        byModel: {
          'qwen3-14b': { title: 'Telekom Rechnung', correspondent: 'Deutsche Telekom AG', tags: ['Rechnung'], proposed: ['Mobilfunk'], error: null, seconds: 3, checks: { lengthOk: true, languageOk: true, datesOk: false } },
          'gemma-3-12b': { title: null, correspondent: null, tags: [], proposed: [], error: 'Invalid <output>', seconds: 1, checks: null },
        },
      },
    ],
  })

  it('renders a summary row per model with percentages', () => {
    expect(html).toContain('<td>qwen3-14b</td>')
    expect(html).toContain('70.0%')
    expect(html).toContain('3.3 s')
  })

  it('shows per-document results side by side and escapes HTML', () => {
    expect(html).toContain('Rechnung &lt;Telekom&gt;')
    expect(html).toContain('Invalid &lt;output&gt;')
    expect(html).toContain('NEW: Mobilfunk')
    expect(html).toContain('dates?')
    expect(html).not.toContain('<Telekom>')
  })
})
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run tests/eval/report.test.ts`
Expected: FAIL, because the module does not exist.

- [ ] **Step 7: Implement `src/eval/report.ts`**

```ts
import type { ModelSummary, TitleChecks } from './metrics'

export interface ReportCell {
  title: string | null
  correspondent: string | null
  tags: string[]
  proposed: string[]
  error: string | null
  seconds: number
  checks: TitleChecks | null
}

export interface ReportRow {
  documentId: number
  truth: { title: string; correspondent: string; tags: string[] }
  byModel: Record<string, ReportCell>
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const pct = (n: number) => `${(n * 100).toFixed(1)}%`

function cell(c: ReportCell | undefined): string {
  if (!c) return '<td></td>'
  if (c.error) return `<td class="err">${esc(c.error)}</td>`
  const failed = c.checks ? Object.entries(c.checks).filter(([, ok]) => !ok).map(([k]) => k.replace(/Ok$/, '?')) : []
  return `<td><b>${esc(c.title ?? '')}</b>${failed.length ? ` <span class="warn">${failed.join(' ')}</span>` : ''}
<br>${esc(c.correspondent ?? '—')}<br>${c.tags.map(esc).join(', ')}${c.proposed.map((p) => ` <span class="new">NEW: ${esc(p)}</span>`).join('')}
<br><small>${c.seconds.toFixed(1)} s</small></td>`
}

export function renderReport(input: { generatedAt: string; summaries: ModelSummary[]; rows: ReportRow[] }): string {
  const models = input.summaries.map((s) => s.model)
  const summaryRows = input.summaries
    .map(
      (s) =>
        `<tr><td>${esc(s.model)}</td><td>${s.documents}</td><td>${pct(s.correspondentAccuracy)}</td><td>${pct(s.tagPrecision)}</td><td>${pct(s.tagRecall)}</td><td>${pct(s.tagF1)}</td><td>${pct(s.newNameRate)}</td><td>${pct(s.failureRate)}</td><td>${pct(s.titleChecksPassRate)}</td><td>${s.avgSeconds.toFixed(1)} s</td></tr>`,
    )
    .join('\n')
  const detailRows = input.rows
    .map(
      (r) =>
        `<tr><td>#${r.documentId}<br><b>${esc(r.truth.title)}</b><br>${esc(r.truth.correspondent)}<br>${r.truth.tags.map(esc).join(', ')}</td>${models.map((m) => cell(r.byModel[m])).join('')}</tr>`,
    )
    .join('\n')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Paperless Suggest eval ${esc(input.generatedAt)}</title>
<style>
body{font:14px system-ui,sans-serif;margin:24px;color:#111}
table{border-collapse:collapse;margin-bottom:32px}
td,th{border:1px solid #ddd;padding:6px 8px;vertical-align:top;text-align:left}
th{background:#f5f5f5}
.err{color:#b91c1c}.warn{color:#b45309;font-size:12px}.new{color:#b45309;border:1px dashed #b45309;border-radius:8px;padding:0 4px;font-size:12px}
</style></head><body>
<h1>Model evaluation</h1><p>Generated ${esc(input.generatedAt)}</p>
<h2>Summary</h2>
<table><tr><th>Model</th><th>Docs</th><th>Correspondent acc.</th><th>Tag precision</th><th>Tag recall</th><th>Tag F1</th><th>New-name rate</th><th>Failures</th><th>Title checks</th><th>Avg time</th></tr>
${summaryRows}
</table>
<h2>Per document</h2>
<table><tr><th>Ground truth</th>${models.map((m) => `<th>${esc(m)}</th>`).join('')}</tr>
${detailRows}
</table>
</body></html>
`
}
```

- [ ] **Step 8: Run tests and typecheck**

Run: `npx vitest run tests/eval && npm run typecheck`
Expected: all PASS; `tsc` exits 0.

- [ ] **Step 9: Commit**

```bash
git add src/eval/metrics.ts src/eval/report.ts tests/eval
git commit -m "feat: evaluation metrics and HTML report" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 18: Evaluation CLI

**Files:**
- Create: `src/eval/run.ts`
- Test: `tests/eval/run.test.ts`

**Interfaces:**
- Consumes: `loadConfig` (Task 1); `createPaperlessClient`, `loadVocabulary`, `selectableTags` (Task 3); `createLlmClient` (Task 4); `createSuggester` (Task 7); `loadExamples` (Task 6); `summarize`, `checkTitle` (Task 17); `renderReport` (Task 17)
- Produces:
  ```ts
  export interface EvalArgs { models: string[]; sample: number; outDir: string }
  export function parseArgs(argv: string[]): EvalArgs          // throws Error with usage text on bad input
  export function pickSample(docs: PaperlessDocument[], inboxTagId: number, n: number): PaperlessDocument[]
  export function runEval(deps: { paperless: PaperlessClient; llm: LlmClient; inboxTag: string | null; maxContentChars: number; matchThreshold: number; models: string[]; sample: number; log?: (line: string) => void }): Promise<{ summaries: ModelSummary[]; rows: ReportRow[] }>
  ```
  CLI: `npm run eval -- --models qwen3-14b,gemma-3-12b [--sample 50] [--out eval-results]`. It needs `PAPERLESS_URL`, `PAPERLESS_TOKEN` and `LLM_BASE_URL`, but not `APP_PASSWORD`. It writes `<out>/<timestamp>.html` and prints the summary table.

- [ ] **Step 1: Write the failing test `tests/eval/run.test.ts`**

```ts
import { describe, expect, it, vi } from 'vitest'
import type { LlmClient, LlmRequest } from '../../src/llm/client'
import { parseArgs, pickSample, runEval } from '../../src/eval/run'
import { fakePaperless } from '../helpers/fakes'
import { makeDocument, makeVocabulary } from '../helpers/fixtures'

describe('parseArgs', () => {
  it('parses models, sample and output dir', () => {
    expect(parseArgs(['--models', 'a,b', '--sample', '10', '--out', 'x'])).toEqual({ models: ['a', 'b'], sample: 10, outDir: 'x' })
    expect(parseArgs(['--models=a'])).toEqual({ models: ['a'], sample: 50, outDir: 'eval-results' })
  })

  it('requires models and a positive sample', () => {
    expect(() => parseArgs([])).toThrow(/--models/)
    expect(() => parseArgs(['--models', 'a', '--sample', '0'])).toThrow(/--sample/)
  })
})

describe('pickSample', () => {
  const doc = (id: number, correspondent: number | null, tags = [2], content = 'text') =>
    makeDocument({ id, correspondent, tags, content })

  it('keeps only usable documents and spreads the sample across correspondents', () => {
    const docs = [
      doc(1, 10), doc(2, 10), doc(3, 10), doc(4, 11), doc(5, 12),
      doc(6, null), doc(7, 10, [1]), doc(8, 10, [2], '  '),
    ]
    expect(pickSample(docs, 1, 4).map((d) => d.id)).toEqual([3, 4, 5, 2])
  })
})

describe('runEval', () => {
  it('runs every model over the sample and never shows a sample doc as example', async () => {
    const v = makeVocabulary()
    const sampleDocs = [
      makeDocument({ id: 1, correspondent: 10, tags: [2], content: 'SAMPLE-ONE Deutsche Telekom AG' }),
      makeDocument({ id: 2, correspondent: 10, tags: [2, 3], content: 'SAMPLE-TWO Deutsche Telekom AG' }),
    ]
    const other = makeDocument({ id: 9, correspondent: 10, tags: [2], content: 'OTHER-DOC', title: 'Other' })
    const paperless = fakePaperless({
      listTags: async () => v.tags,
      listCorrespondents: async () => v.correspondents,
      // the large fetch feeds the sample; the small per-document fetches feed few-shot examples
      listFiledDocuments: async ({ limit }) => (limit >= 1000 ? sampleDocs : [...sampleDocs, other]),
    })
    const prompts: LlmRequest[] = []
    const llm: LlmClient = {
      health: vi.fn(),
      complete: vi.fn(async (req: LlmRequest) => {
        prompts.push(req)
        return {
          model: req.model ?? '?',
          content: JSON.stringify({ title: 'Telekom Rechnung', correspondent: 'Deutsche Telekom AG', proposed_new_correspondent: null, tags: ['Rechnung'], proposed_new_tags: [] }),
        }
      }),
    }
    const { summaries, rows } = await runEval({ paperless, llm, inboxTag: null, maxContentChars: 6000, matchThreshold: 0.85, models: ['a', 'b'], sample: 2 })

    expect(summaries.map((s) => s.model)).toEqual(['a', 'b'])
    expect(summaries[0]).toMatchObject({ documents: 2, correspondentAccuracy: 1, failureRate: 0, tagPrecision: 1 })
    expect(summaries[0]!.tagRecall).toBeCloseTo(2 / 3)
    expect(prompts).toHaveLength(4)
    for (const p of prompts) {
      const examples = p.user.split('### Document to file')[0]!
      expect(examples).toContain('OTHER-DOC')
      expect(examples).not.toContain('SAMPLE-')
    }
    expect(rows.map((r) => r.documentId)).toEqual([2, 1])
    expect(rows[0]!.truth).toEqual({ title: 'scan_0001', correspondent: 'Deutsche Telekom AG', tags: ['Rechnung', 'Telefon/Internet'] })
    expect(rows[0]!.byModel.a).toMatchObject({ title: 'Telekom Rechnung', correspondent: 'Deutsche Telekom AG', tags: ['Rechnung'], error: null })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/eval/run.test.ts`
Expected: FAIL, because the module does not exist.

- [ ] **Step 3: Implement `src/eval/run.ts`**

```ts
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ConfigError, loadConfig, type Config } from '../config'
import { createLlmClient, type LlmClient } from '../llm/client'
import { createPaperlessClient, type PaperlessClient } from '../paperless/client'
import type { PaperlessDocument } from '../paperless/types'
import { loadVocabulary } from '../paperless/vocabulary'
import { loadExamples } from '../suggest/examples'
import { createSuggester } from '../suggest/suggester'
import type { Example } from '../suggest/types'
import { checkTitle, summarize, type EvalCase, type EvalOutcome, type ModelSummary } from './metrics'
import { renderReport, type ReportRow } from './report'

const USAGE = 'Usage: npm run eval -- --models <id,id,...> [--sample 50] [--out eval-results]'
const FILED_FETCH_LIMIT = 1000

export interface EvalArgs {
  models: string[]
  sample: number
  outDir: string
}

export function parseArgs(argv: string[]): EvalArgs {
  const values = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (!arg.startsWith('--')) continue
    const eq = arg.indexOf('=')
    if (eq > 0) values.set(arg.slice(2, eq), arg.slice(eq + 1))
    else values.set(arg.slice(2), argv[++i] ?? '')
  }
  const models = (values.get('models') ?? '').split(',').map((m) => m.trim()).filter(Boolean)
  if (models.length === 0) throw new Error(`--models is required.\n${USAGE}`)
  const sample = Number(values.get('sample') ?? 50)
  if (!Number.isInteger(sample) || sample <= 0) throw new Error(`--sample must be a positive integer.\n${USAGE}`)
  return { models, sample, outDir: values.get('out') ?? 'eval-results' }
}

/** Filed documents with correspondent, at least one real tag and text; round-robin across correspondents, newest first. */
export function pickSample(docs: PaperlessDocument[], inboxTagId: number, n: number): PaperlessDocument[] {
  const groups = new Map<number, PaperlessDocument[]>()
  for (const d of docs) {
    if (d.correspondent === null || !d.content.trim()) continue
    if (!d.tags.some((t) => t !== inboxTagId)) continue
    const list = groups.get(d.correspondent) ?? []
    list.push(d)
    groups.set(d.correspondent, list)
  }
  const queues = [...groups.entries()].sort(([a], [b]) => a - b).map(([, list]) => list.sort((a, b) => b.id - a.id))
  const out: PaperlessDocument[] = []
  while (out.length < n && queues.some((q) => q.length > 0)) {
    for (const q of queues) {
      const next = q.shift()
      if (next && out.length < n) out.push(next)
    }
  }
  return out
}

export async function runEval(deps: {
  paperless: PaperlessClient
  llm: LlmClient
  inboxTag: string | null
  maxContentChars: number
  matchThreshold: number
  models: string[]
  sample: number
  log?: (line: string) => void
}): Promise<{ summaries: ModelSummary[]; rows: ReportRow[] }> {
  const log = deps.log ?? (() => {})
  const vocab = await loadVocabulary(deps.paperless, deps.inboxTag)
  const filed = await deps.paperless.listFiledDocuments({ inboxTagId: vocab.inboxTagId, limit: FILED_FETCH_LIMIT })
  const sample = pickSample(filed, vocab.inboxTagId, deps.sample)
  const exclude = new Set(sample.map((d) => d.id))
  log(`Sample: ${sample.length} documents from ${new Set(sample.map((d) => d.correspondent)).size} correspondents`)

  const tagName = new Map(vocab.tags.map((t) => [t.id, t.name]))
  const correspondentName = new Map(vocab.correspondents.map((c) => [c.id, c.name]))
  const names = (ids: number[]) => ids.map((id) => tagName.get(id) ?? `#${id}`)

  const examples = new Map<number, Example[]>()
  for (const d of sample) examples.set(d.id, await loadExamples(deps.paperless, vocab, d.content, exclude))

  const rows: ReportRow[] = sample.map((d) => ({
    documentId: d.id,
    truth: {
      title: d.title,
      correspondent: correspondentName.get(d.correspondent!) ?? '',
      tags: names(d.tags.filter((t) => t !== vocab.inboxTagId)),
    },
    byModel: {},
  }))

  const suggester = createSuggester({ llm: deps.llm, maxContentChars: deps.maxContentChars, matchThreshold: deps.matchThreshold })
  const summaries: ModelSummary[] = []
  for (const model of deps.models) {
    const cases: EvalCase[] = []
    for (const [i, d] of sample.entries()) {
      const started = performance.now()
      let outcome: EvalOutcome
      try {
        outcome = await suggester.suggest({ content: d.content, vocabulary: vocab, examples: examples.get(d.id) ?? [], model })
      } catch (e) {
        outcome = { kind: 'exception', error: (e as Error).message }
      }
      const seconds = (performance.now() - started) / 1000
      const truthTags = d.tags.filter((t) => t !== vocab.inboxTagId)
      cases.push({ truth: { documentId: d.id, title: d.title, correspondentId: d.correspondent!, tagIds: truthTags, content: d.content }, outcome, seconds })
      const s = outcome.kind === 'ok' ? outcome.suggestion : null
      rows[i]!.byModel[model] = {
        title: s?.title ?? null,
        correspondent: s?.correspondentId != null ? (correspondentName.get(s.correspondentId) ?? null) : null,
        tags: s ? names(s.tagIds) : [],
        proposed: s ? [...(s.proposedCorrespondent ? [s.proposedCorrespondent.name] : []), ...s.proposedTags.map((p) => p.name)] : [],
        error: outcome.kind === 'error' || outcome.kind === 'exception' ? outcome.error : outcome.kind === 'no_text' ? 'no text' : null,
        seconds,
        checks: s ? checkTitle(s.title, d.content) : null,
      }
      log(`[${model}] ${i + 1}/${sample.length} #${d.id} ${outcome.kind} ${seconds.toFixed(1)}s`)
    }
    summaries.push(summarize(model, cases))
  }
  return { summaries, rows }
}

async function main(): Promise<void> {
  let args: EvalArgs
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.error((e as Error).message)
    process.exit(1)
  }
  let config: Config
  try {
    config = loadConfig(process.env, { requireAuth: false })
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message)
      process.exit(1)
    }
    throw e
  }
  const { summaries, rows } = await runEval({
    paperless: createPaperlessClient({ baseUrl: config.paperlessUrl, token: config.paperlessToken }),
    llm: createLlmClient({ baseUrl: config.llmBaseUrl, model: null }),
    inboxTag: config.inboxTag,
    maxContentChars: config.maxContentChars,
    matchThreshold: config.newNameMatchThreshold,
    models: args.models,
    sample: args.sample,
    log: (line) => console.error(line),
  })
  const generatedAt = new Date().toISOString()
  mkdirSync(args.outDir, { recursive: true })
  const file = path.join(args.outDir, `${generatedAt.replace(/[:.]/g, '-')}.html`)
  writeFileSync(file, renderReport({ generatedAt, summaries, rows }))
  console.table(
    summaries.map((s) => ({
      model: s.model,
      corrAcc: s.correspondentAccuracy.toFixed(3),
      tagF1: s.tagF1.toFixed(3),
      newNames: s.newNameRate.toFixed(3),
      failures: s.failureRate.toFixed(3),
      titles: s.titleChecksPassRate.toFixed(3),
      secPerDoc: s.avgSeconds.toFixed(1),
    })),
  )
  console.log(`Report: ${file}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/eval && npm run typecheck`
Expected: all PASS; `tsc` exits 0.

- [ ] **Step 5: Check the CLI's argument handling**

Run: `npm run eval; echo "exit=$?"`
Expected: `--models is required.` followed by the usage line, then `exit=1`.

- [ ] **Step 6: Commit**

```bash
git add src/eval/run.ts tests/eval/run.test.ts
git commit -m "feat: model evaluation CLI on already-filed documents" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 19: Production build, Docker image and README

**Files:**
- Create: `tsup.config.ts`, `Dockerfile`, `.dockerignore`, `docker-compose.example.yml`, `README.md`

**Interfaces:**
- Consumes: `src/server.ts` (Task 12), `src/eval/run.ts` (Task 18), the web app (Task 15)
- Produces: `npm run build` → `dist/server.js`, `dist/eval.js`, `dist/web/`; Docker image running `node dist/server.js` on port 3000 with `/data` as a volume.

- [ ] **Step 1: Create `tsup.config.ts`**

```ts
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { server: 'src/server.ts', eval: 'src/eval/run.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  sourcemap: true,
  clean: false, // dist/web is written by the Vite build that runs first
})
```

- [ ] **Step 2: Build and smoke-test the production bundle**

Run:
```bash
npm run build && ls dist dist/web
```
Expected: `dist/` contains `server.js`, `eval.js` and `web/`, and `dist/web/` contains `index.html` and `assets`.

Run:
```bash
PAPERLESS_URL=http://127.0.0.1:9 PAPERLESS_TOKEN=x LLM_BASE_URL=http://127.0.0.1:9/v1 AUTH_DISABLED=true DATA_DIR=./.tmp-data PORT=3998 node dist/server.js & SERVER_PID=$!; sleep 3; curl -s localhost:3998/ | head -c 200; echo; curl -s localhost:3998/api/status; echo; kill $SERVER_PID; rm -rf ./.tmp-data
```
Expected: the first curl prints the start of `index.html` (`<!doctype html>…Paperless Suggest…`); the second prints status JSON.

- [ ] **Step 3: Create `.dockerignore`**

```
node_modules
dist
.git
.superpowers
.playwright-mcp
eval-results
test-results
playwright-report
data
*.sqlite
.env
```

- [ ] **Step 4: Create `Dockerfile`**

```dockerfile
FROM node:22-slim AS build
WORKDIR /app
# build tools for better-sqlite3 when no prebuilt binary matches (e.g. some ARM NAS)
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=3000
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
CMD ["node", "dist/server.js"]
```

- [ ] **Step 5: Create `docker-compose.example.yml`**

```yaml
# Add this service to the compose project that runs Paperless-ngx,
# so it can reach Paperless by its service name.
services:
  paperless-suggest:
    build: .
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      PAPERLESS_URL: http://webserver:8000        # Paperless service name inside the compose network
      PAPERLESS_TOKEN: change-me                  # Paperless → Profile → API Auth Token
      LLM_BASE_URL: http://192.168.1.50:1234/v1   # LM Studio on your PC ("Serve on local network")
      # LLM_MODEL: qwen3-14b                      # optional; default = model loaded in LM Studio
      APP_PASSWORD: change-me
      # AUTH_DISABLED: "true"                     # only behind an authenticating reverse proxy
    volumes:
      - suggest-data:/data

volumes:
  suggest-data:
```

- [ ] **Step 6: Build and run the Docker image**

Run:
```bash
docker build -t paperless-suggest . && docker run --rm paperless-suggest; echo "exit=$?"
```
Expected: the build succeeds; the container prints `Invalid configuration:` listing `PAPERLESS_URL`, `PAPERLESS_TOKEN` and `LLM_BASE_URL`, then `exit=1`.

Run:
```bash
docker run --rm -d --name ps-smoke -p 3997:3000 -e PAPERLESS_URL=http://127.0.0.1:9 -e PAPERLESS_TOKEN=x -e LLM_BASE_URL=http://127.0.0.1:9/v1 -e AUTH_DISABLED=true paperless-suggest && sleep 3 && curl -s localhost:3997/api/status; echo; docker stop ps-smoke
```
Expected: status JSON with `"paperless":{"ok":false,...}`.

- [ ] **Step 7: Create `README.md`**

````markdown
# Paperless Suggest

Suggests **title, correspondent and tags** for documents in your Paperless-ngx inbox using a
local LLM in [LM Studio](https://lmstudio.ai). Nothing changes in Paperless until you press
**Apply** in the review screen, which works on desktop and on mobile.

- Existing tags and correspondents are strictly preferred: the model's answer is restricted to
  your current names by a JSON schema. A new name only ever appears as an explicit, dashed-orange
  **NEW** proposal with the closest existing names offered as one-tap alternatives.
- Suggestions are computed in the background whenever LM Studio is reachable, so reviewing never
  waits for the model.
- Apply writes title, correspondent and tags and removes the inbox tag.

Design: `docs/superpowers/specs/2026-09-29-paperless-suggest-design.md`

## Setup

1. **LM Studio** (on the PC with the GPU): load a model, open the Developer tab, start the server
   and enable **Serve on local network**. Keep "Just-in-time model loading" on if you want to run
   the evaluation.
2. **Paperless**: create an API token (Profile → API Auth Token). Mark your inbox tag as
   "Inbox tag", or set `INBOX_TAG`.
3. **Run** next to Paperless: copy `docker-compose.example.yml` into your Paperless compose
   project, fill in the values and run `docker compose up -d --build paperless-suggest`.
   Open `http://<server>:3000`.

For access from your phone outside your home network, use the same path you use for Paperless
(reverse proxy, VPN or Tailscale).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PAPERLESS_URL` | required | Paperless base URL |
| `PAPERLESS_TOKEN` | required | API token with write access |
| `LLM_BASE_URL` | required | LM Studio API, e.g. `http://192.168.1.50:1234/v1` |
| `LLM_MODEL` | model loaded in LM Studio | Model id to request |
| `INBOX_TAG` | tag flagged "inbox tag" | Inbox tag name or id |
| `APP_PASSWORD` | required unless `AUTH_DISABLED` | Login password |
| `AUTH_DISABLED` | `false` | Skip built-in login (behind an authenticating proxy only) |
| `POLL_INTERVAL` | `300` | Seconds between inbox polls |
| `MAX_CONTENT_CHARS` | `6000` | OCR text sent to the model |
| `NEW_NAME_MATCH_THRESHOLD` | `0.85` | Similarity above which a proposed new name is mapped to an existing one |
| `DATA_DIR` | `/data` | SQLite location |
| `PORT` | `3000` | HTTP port |

## Choosing a model

Compare models on documents you have already filed. Their current title, correspondent and
tags serve as the correct answers:

```bash
cp .env.example .env   # fill in PAPERLESS_URL, PAPERLESS_TOKEN, LLM_BASE_URL
npm ci
node --env-file=.env --import tsx src/eval/run.ts --models qwen3-14b,gemma-3-12b --sample 50
```

In Docker: `docker compose exec paperless-suggest node dist/eval.js --models qwen3-14b --sample 50`.

The HTML report in `eval-results/` shows, per model: correspondent accuracy, tag
precision/recall/F1, **new-name rate** (how often it proposed a new tag or correspondent even
though an existing one was correct), failure rate, title checks and seconds per document. It also
lists every document's titles side by side, so you can judge them yourself. Set the winner as
`LLM_MODEL`.

## Keyboard shortcuts (desktop)

| Key | Action |
|---|---|
| Enter | Apply & next |
| S | Skip |
| R | Regenerate suggestion |

## Development

```bash
npm ci
cp .env.example .env
node --env-file=.env --import tsx --watch src/server.ts   # API on :3000
npm run dev:web                                           # UI on :5173, proxies /api
npm test                                                  # unit + component tests
npm run test:e2e                                          # Playwright, desktop + mobile
npm run typecheck
```
````

- [ ] **Step 8: Run the full verification suite**

Run: `npm run typecheck && npm test && npm run test:e2e && npm run build`
Expected: `tsc` exits 0; every Vitest test passes; the Playwright run passes (skipped tests are expected); the build succeeds.

- [ ] **Step 9: Commit**

```bash
git add tsup.config.ts Dockerfile .dockerignore docker-compose.example.yml README.md
git commit -m "chore: production build, Docker image and README" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

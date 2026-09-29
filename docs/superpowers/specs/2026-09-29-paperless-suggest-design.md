# Paperless Suggest — Design

Date: 2026-09-29
Status: Draft for review

## 1. Purpose

A self-hosted web app that reads the Paperless-ngx inbox, uses a local LLM (LM Studio)
to suggest **title, correspondent and tags** for each document, and applies them only
after manual confirmation.

### Why not an existing tool

paperless-gpt and clusterzx/paperless-ai were tried and fell short in two ways that
drive this design:

1. **They invented new tags/correspondents** (near-duplicates) instead of reusing existing ones.
2. **The review UX was clunky.**

### Success criteria

- Suggestions reuse existing tags/correspondents; a new name is only ever an explicit,
  visibly marked proposal with nearby existing alternatives offered.
- Nothing changes in Paperless without an explicit Apply by the user.
- Reviewing a document takes one screen and, in the common case, one click/keypress —
  on desktop and on mobile.
- The choice of LLM is backed by a measured evaluation on the user's own documents.

### Out of scope (YAGNI)

- Document type, dates, custom fields, storage paths.
- A list/queue view (the review screen walks the inbox one document at a time).
- Vision/PDF-image input (OCR text from Paperless is the input).
- Tool-calling / MCP-based agents (see §5.6).
- A settings UI (configuration via environment variables).
- Multi-user support.

## 2. Context and constraints

| Item | Value |
|---|---|
| Paperless-ngx | Runs on a server |
| This app | Runs 24/7 in Docker next to Paperless |
| LLM | LM Studio on the user's PC (RTX 5080, 16 GB VRAM), OpenAI-compatible API, reachable over the network; **often offline** |
| Vocabulary | < 100 tags, < 100 correspondents |
| Documents | Mixed German / English |
| Clients | Desktop browser and mobile browser |

## 3. Architecture

Single Docker container. A Node backend serves the API and the built React SPA; SQLite
(on a mounted volume) stores suggestions.

```
┌──────────── Server (next to Paperless) ────────────┐        ┌─ User PC ──┐
│  paperless-suggest container                       │        │ LM Studio  │
│  ┌───────────┐   ┌───────────┐   ┌──────────────┐  │  HTTP  │ (OpenAI-   │
│  │ React SPA │──▶│ API (Hono)│──▶│ Worker loop  │──┼───────▶│ compatible │
│  └───────────┘   └─────┬─────┘   └──────┬───────┘  │        │ API :1234) │
│                        │ SQLite         │          │        └────────────┘
│                        ▼                ▼          │
│                  Paperless REST API (token)        │
└────────────────────────────────────────────────────┘
```

### Stack

Node 22, TypeScript, Hono, better-sqlite3, zod, `openai` SDK (pointed at LM Studio),
Vite + React + TanStack Query + Tailwind. One npm package; frontend lives in `web/`;
one build, one image.

### Components

Each unit has one purpose and is testable in isolation.

1. **`paperless` client** — typed wrapper over the Paperless REST API: list inbox
   documents, get document (content, `modified`, thumbnail/preview URLs), list
   tags/correspondents (with document counts), create tag/correspondent, PATCH document.
2. **`llm` client** — OpenAI SDK against `LLM_BASE_URL`. `complete(prompt, jsonSchema)`
   returns zod-validated output. `health()` reports reachability and loaded model.
3. **`suggester`** — pure logic: `(document, vocabulary, examples) → Suggestion`. Builds
   the JSON schema and prompt, calls an injected LLM client, post-processes new-name
   proposals. No direct network access. Defined behind an interface so alternative
   strategies can be plugged in and compared by the eval.
4. **`worker`** — polls the inbox every `POLL_INTERVAL` seconds; for each inbox document
   without a current suggestion, runs the suggester when LM Studio is reachable.
   Processes **one document at a time**.
5. **`store`** — SQLite. Holds suggestions and their state. Paperless remains the source
   of truth for documents and vocabulary.
6. **HTTP API** — see §6.
7. **`eval` CLI** — model comparison on already-filed documents, reusing `suggester`
   (see §9).

## 4. Data model (SQLite)

`suggestions`

| Column | Type | Notes |
|---|---|---|
| `document_id` | integer PK | Paperless document id |
| `status` | text | `pending` \| `ready` \| `applied` \| `error` \| `no_text` |
| `title` | text | suggested title |
| `correspondent_id` | integer null | existing correspondent |
| `proposed_correspondent` | text null | new name, if no existing one fits |
| `tag_ids` | json | existing tag ids |
| `proposed_tags` | json | new tag names, each with up to 3 nearest existing tag ids |
| `matched_notes` | json | e.g. `{"Telekom": "Deutsche Telekom AG"}` for auto-mapped proposals |
| `model` | text | model id that produced the suggestion |
| `content_hash` | text | hash of the OCR text used |
| `vocab_hash` | text | hash of the tag + correspondent lists used |
| `doc_modified` | text | Paperless `modified` timestamp at suggestion time |
| `in_inbox` | integer | 1 while the document carries the inbox tag (updated every poll) |
| `added` | text | Paperless `added` timestamp, used for queue order |
| `priority` | integer | 1 for user-requested regeneration, processed first |
| `error` | text null | last error message |
| `attempts` | integer | LLM attempts for the current version |
| `created_at`, `updated_at` | text | |

A suggestion is **stale** when `content_hash` or `vocab_hash` no longer match; the worker
regenerates stale suggestions whose status is `pending`, `ready` or `error`.
A document that is back in the inbox after being applied is reset to `pending`.
`updated_at` changes only when the suggestion or its status changes, not on every poll.
The document-count part of the vocabulary is excluded from `vocab_hash`, so applying
documents does not make every other suggestion stale.
Skipping a document in the UI does not change its status; it only moves on to the next
document for that session.

## 5. Suggestion pipeline

### 5.1 Input

- OCR text (`content`) from Paperless, truncated to `MAX_CONTENT_CHARS` (default 6000).
  Sender and subject are typically near the start.
- Empty or whitespace-only content → status `no_text`, no LLM call; user can fill
  fields manually.

### 5.2 Vocabulary and schema

Tags and correspondents are fetched fresh on every worker cycle. The JSON schema is built
dynamically:

```jsonc
{
  "type": "object",
  "required": ["title", "correspondent", "proposed_new_correspondent", "tags", "proposed_new_tags"],
  "properties": {
    "title": { "type": "string", "maxLength": 80 },
    "correspondent": { "enum": ["<existing names>…", null] },
    "proposed_new_correspondent": { "type": ["string", "null"] },
    "tags": { "type": "array", "items": { "enum": ["<existing tag names>…"] } },
    "proposed_new_tags": { "type": "array", "maxItems": 2, "items": { "type": "string" } }
  }
}
```

The inbox tag itself is excluded from the tag enum. LM Studio's structured output
(grammar-constrained decoding) makes it impossible for the model to put a non-existing
name into `correspondent` or `tags`. New names can only appear in the explicit
`proposed_new_*` fields. If `correspondent` is non-null, `proposed_new_correspondent`
is ignored.

### 5.3 Prompt

- System prompt: task description; rule "Use existing tags and correspondents. Propose a
  new one only if none fits at all."; title rules (document language, ≤ 80 chars,
  pattern like `<Correspondent> <document kind> <subject/period>`, no invented dates).
- Tag list with per-tag document counts, so the model sees which tags are actually used.
- Correspondent list.
- 2–3 few-shot examples: already-filed documents from the likely correspondent (chosen by
  a cheap string match of correspondent names against the OCR text; otherwise the most
  recently filed documents), each shown as truncated text → title / correspondent / tags.
- The document text.

Estimated prompt size: 3–4k tokens.

### 5.4 Post-processing of new-name proposals

Each proposed new tag/correspondent is compared to existing names using normalization
(case, whitespace, umlaut folding, removal of legal suffixes like `AG`, `GmbH`, `Inc`)
plus a fuzzy similarity score (plus containment, so "Telekom" ≈ "Deutsche Telekom AG").

- Score ≥ `NEW_NAME_MATCH_THRESHOLD` (default 0.85): replaced by the existing entry,
  recorded in `matched_notes`, shown in the UI as existing with a "matched from …" note.
- Below threshold: stays a NEW proposal, stored with its 3 nearest existing names.

### 5.5 Validation and retries

Output is validated with zod (in addition to the schema constraint). On failure: one
retry; after that, status `error` with the reason.

### 5.6 Rejected alternative: tool calling / MCP

Letting the model fetch content and vocabulary via tools was considered and rejected:
with < 100 tags/correspondents the full lists are ~500–1000 tokens, and fetched content
lands in the context anyway, so there is no context saving. Multi-step tool use is
markedly less reliable on 8–14B local models, adds latency, weakens the "only existing
names" guarantee, and makes the eval non-deterministic. The `suggester` interface keeps
this option open if the vocabulary grows large.

## 6. HTTP API

All routes require an authenticated session unless `AUTH_DISABLED=true`.

| Route | Purpose |
|---|---|
| `POST /api/login`, `POST /api/logout` | Session handling |
| `GET /api/status` | Paperless reachable, LLM reachable + model, counts (`ready`, `pending`, `error`) |
| `GET /api/queue/next?after=<id>` | Next reviewable document (`ready`, `error`, `no_text`) in inbox order after `after` |
| `GET /api/documents/:id` | Suggestion + current Paperless values + preview/thumbnail/PDF URLs (proxied) + vocabulary |
| `GET /api/documents/:id/preview`, `/thumb` | Proxied from Paperless (token stays server-side). OCR text is part of the document response |
| `POST /api/documents/:id/apply` | Body: final title, correspondent (id or new name), tags (ids + new names), and the `modified` value the UI loaded (`expectedModified`). Applies to Paperless |
| `POST /api/documents/:id/regenerate` | Marks `pending`, worker picks it up with priority |

### Apply semantics

1. Re-fetch the document; if `modified` differs from `expectedModified` (the value the
   user was looking at), return `409` with the current values. The UI shows a warning and the refreshed state; nothing is written.
2. Validate referenced tag/correspondent ids still exist; ids that disappeared come back
   in a `409` as NEW proposals for the user to confirm or drop.
3. Create the new tags/correspondent the user kept.
4. A single PATCH: title, correspondent, tags = final tags **without** the inbox tag.
5. Status → `applied`.

## 7. Review UI

A mockup was reviewed during brainstorming (desktop split view + mobile layout).

### Layout

- **Header / status bar:** app name, "Inbox n / m ready · k waiting for LLM", LLM
  indicator (online/offline + model name).
- **Desktop (≥ 900 px):** split view. Left: document preview (page navigation, open PDF,
  toggle OCR text). Right: editable fields and actions.
- **Mobile:** preview on top (tap → full-screen PDF), fields below, **sticky bottom
  action bar** (Skip · Regenerate · Apply).

### Fields

- **Title:** editable text input; original title shown struck through beneath.
- **Correspondent:** dropdown of existing correspondents only, plus an explicit
  "create new…" entry. A NEW proposal is shown with the same dashed-orange marking and
  nearest alternatives as tags.
- **Tags:** chips, pre-filled with the union of tags already on the document (e.g. set by
  Paperless matching rules, inbox tag excluded) and the suggested tags. Existing = solid; NEW = dashed orange, with a hint line
  "'X' doesn't exist yet. Similar: A · B" where tapping an alternative swaps the chip.
  Chips removable; "+ add tag" opens a searchable list of existing tags.
- Auto-matched proposals show a small "matched from '…'" note.
- Note: "Inbox tag will be removed on apply."

### Actions and shortcuts

| Action | Desktop key | Effect |
|---|---|---|
| Apply & next | Enter | Apply (§6), load next document |
| Skip | S | Next document, no change |
| Regenerate | R | Request new suggestion |

The next document's data is prefetched, so moving on is instant. Documents in `error` or
`no_text` state show the reason and empty/partial editable fields.
When no reviewable document is left, an empty state shows the counts of pending
documents and the LLM status.

## 8. Error handling, security, configuration

### Error handling

| Situation | Behavior |
|---|---|
| LM Studio unreachable | Worker checks `/v1/models` with backoff (1 min doubling to 10 min). Documents stay `pending`; UI shows "LLM offline · n waiting". Processing resumes automatically. |
| Invalid LLM output | zod validation, one retry, then `error` with reason; Regenerate + manual edit available. |
| Empty OCR text | `no_text`, no LLM call, manual edit available. |
| Document modified in Paperless since suggestion | Apply returns 409; UI reloads and warns; no overwrite. |
| Document left the inbox | Dropped from the queue on next poll (row kept, status unchanged). |
| Referenced tag/correspondent deleted | Detected on Apply; turned into a NEW proposal to confirm or drop. |
| Paperless unreachable | UI banner; worker pauses and retries next cycle. |

### Security

- Single-user login: `APP_PASSWORD`; HTTP-only, `SameSite=Lax`, `Secure` (when served
  over HTTPS) session cookie valid for 30 days. Login attempts rate-limited.
- `AUTH_DISABLED=true` for deployments behind an authenticating reverse proxy.
- Paperless token and LLM URL are only used server-side; document files and thumbnails are
  proxied.
- Remote/mobile access uses the user's existing path to Paperless (reverse proxy / VPN /
  Tailscale); the app does not handle this.

### Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PAPERLESS_URL` | — (required) | Paperless base URL |
| `PAPERLESS_TOKEN` | — (required) | API token with write access |
| `LLM_BASE_URL` | — (required) | e.g. `http://<pc>:1234/v1` |
| `LLM_MODEL` | model loaded in LM Studio | Model id to request |
| `INBOX_TAG` | Paperless tag with `is_inbox_tag` | Inbox tag name or id |
| `APP_PASSWORD` | — (required unless `AUTH_DISABLED`) | Login password |
| `AUTH_DISABLED` | `false` | Skip built-in auth |
| `POLL_INTERVAL` | `300` | Seconds between inbox polls |
| `MAX_CONTENT_CHARS` | `6000` | OCR text truncation |
| `NEW_NAME_MATCH_THRESHOLD` | `0.85` | Auto-map threshold for new-name proposals |
| `DATA_DIR` | `/data` | SQLite location |

Startup fails fast with a clear message if required variables are missing or no inbox
tag can be determined.

## 9. Testing

Vitest throughout.

- **Unit:** schema builder; name normalization + fuzzy matcher (incl. "Telekom" →
  "Deutsche Telekom AG"); apply-payload builder (new-entity creation, inbox tag removal);
  staleness detection.
- **Suggester** with a fake LLM client: valid output, invalid JSON → retry → error,
  proposal auto-mapping, empty content.
- **Paperless client + worker** against msw-mocked Paperless API and in-memory SQLite:
  LLM offline → online, document leaves inbox, modified-conflict on apply, deleted tag.
- **API routes** via Hono `app.request()`, including auth.
- **Frontend:** React Testing Library for the review screen — editing, swapping a NEW chip
  for an alternative, keyboard shortcuts.
- **E2E:** one Playwright test against a mocked backend at desktop and mobile (iPhone)
  viewport: sticky action bar, Apply & next flow.

## 10. Model evaluation (`npm run eval`)

- **Sample:** ~50 already-filed documents (not in inbox) with a correspondent and ≥ 1 tag,
  stratified across correspondents (`--sample N`). Their current values are ground truth.
  Sample documents are excluded from few-shot examples.
- **Models:** `--models a,b,c`; each is requested by id and loaded on demand by LM Studio.
- **Metrics per model:**
  - correspondent accuracy
  - tag precision / recall / F1
  - **new-name rate**: proposals of a new tag/correspondent where the correct existing one
    was available
  - schema/validation failure rate
  - seconds per document
- **Titles:** HTML report shows original title and each model's title side by side for
  manual judgment, plus automatic checks (language matches document, length, no dates
  absent from the text).
- **Output:** `eval-results/<date>.html` with a summary table and per-document details.
- **Initial candidates** (≤ 16 GB VRAM, DE/EN): Qwen3 8B / 14B, Gemma 3 12B,
  Mistral Small 24B (Q4), Qwen3-30B-A3B. The list is re-checked against current releases
  when the eval is first run.

## 11. Deployment

- Multi-stage Dockerfile: build SPA + server, run on `node:22-slim`.
- `docker-compose.example.yml` showing the container next to Paperless with a `/data`
  volume.
- LM Studio: enable "Serve on local network" so the server can reach the PC.

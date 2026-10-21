# Paperless Suggest

Suggests **title, issue date, correspondent and tags** for documents in your Paperless-ngx inbox using a
local LLM in [LM Studio](https://lmstudio.ai). Nothing changes in Paperless until you press
**Apply** in the review screen, which works on desktop and on mobile.

- Existing tags and correspondents are strictly preferred: the model's answer is restricted to
  your current names by a JSON schema. A new name only ever appears as an explicit, dashed-orange
  **NEW** proposal with the closest existing names offered as one-tap alternatives.
- Suggestions are computed in the background whenever LM Studio is reachable, so reviewing never
  waits for the model.
- The issue date ("Ausstellungsdatum", Paperless's *created* date) is read from the document text.
  The review screen shows Paperless's current date struck through when the suggestion differs.
- Apply writes title, issue date, correspondent and tags and removes the inbox tag.

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

The data directory (`./data` in the example) may be a bind mount that Docker creates on first
start: the container takes ownership of it for `USERMAP_UID:USERMAP_GID` and then drops root.

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
| `LLM_CONCURRENCY` | `1` | Documents sent to the LLM at the same time (one document per request) |
| `LLM_CONTEXT_LENGTH` | LM Studio's setting | Context length the model is loaded with; see below |
| `LLM_UNLOAD_WHEN_IDLE` | `false` | Unload the model in LM Studio once no documents are left; see below |
| `MAX_CONTENT_CHARS` | `6000` | OCR text sent to the model |
| `NEW_NAME_MATCH_THRESHOLD` | `0.85` | Similarity above which a proposed new name is mapped to an existing one |
| `DATA_DIR` | `/data` | SQLite location |
| `USERMAP_UID` / `USERMAP_GID` | `1000` | Owner of the data directory; the app runs as this user |
| `PORT` | `3000` | HTTP port |

### Parallel suggestions

With `LLM_CONCURRENCY` above 1, several documents are sent to LM Studio at once. They only run in
parallel if the model is loaded with **Max Concurrent Predictions** (model load settings) at least
as high; otherwise LM Studio queues them.

Parallel requests share the model's context. One document needs up to about 6–7k tokens (prompt
plus the model's answer, including reasoning), so the context must be at least
`LLM_CONCURRENCY × 8192`, or requests fail with "Context size has been exceeded". Set
`LLM_CONTEXT_LENGTH` (e.g. `16384` for two at a time) and the app checks before every run
that has documents to suggest for whether the model is loaded with at least that context. If not, it unloads the model and loads it
again with that context through LM Studio's REST API (LM Studio 0.4 or newer). This also affects
other programs using that model in LM Studio at the time. A larger context needs more VRAM; if
the load fails, the error is shown in the status bar.

### Freeing VRAM when idle

With `LLM_UNLOAD_WHEN_IDLE=true`, the app unloads the model through LM Studio's REST API (LM Studio
0.4 or newer) as soon as a run leaves no documents to suggest for. The next document loads it
again: with `LLM_CONTEXT_LENGTH` set the app loads it itself, otherwise LM Studio's just-in-time
loading does. The app only unloads a model it has used since the last unload, and never while
documents are still waiting.

## Choosing a model

Compare models on documents you have already filed. Their current title, correspondent and
tags serve as the correct answers:

```bash
cp .env.example .env   # fill in PAPERLESS_URL, PAPERLESS_TOKEN, LLM_BASE_URL
npm ci
node --env-file=.env --import tsx src/eval/run.ts --models qwen3-14b,gemma-3-12b --sample 50
```

In Docker: `docker compose exec paperless-suggest node dist/eval.js --models qwen3-14b --sample 50`.
Reports are written to `/data/eval-results` inside the data volume (`DATA_DIR/eval-results`).

The HTML report in `eval-results/` shows, per model: correspondent accuracy, issue-date accuracy, tag
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

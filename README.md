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

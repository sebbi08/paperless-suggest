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

    const metaFor = (d: PaperlessDocument) => ({ contentHash: hashContent(d.content), vocabHash, docModified: d.modified })
    for (const d of docs) {
      if (d.content.trim()) continue
      const stored = store.get(d.id)
      if (stored?.status === 'pending' || store.isStale(d.id)) store.saveResult(d.id, { kind: 'no_text' }, metaFor(d))
    }

    const health = await llm.health()
    if (!health.ok) {
      this.llmDown(health.error)
      return
    }
    this.llmState = { ok: true, model: health.model, error: null }
    this.backoffMs = 0

    for (let id = store.nextWork(); id !== null && !this.stopped; id = store.nextWork()) {
      let doc: PaperlessDocument | undefined
      try {
        doc = byId.get(id) ?? (await paperless.getDocument(id))
        const examples = await loadExamples(paperless, vocab, doc.content, new Set([doc.id]))
        const result = await suggester.suggest({ content: doc.content, vocabulary: vocab, examples })
        store.saveResult(id, result, metaFor(doc))
        this.log.info(`Document ${id}: ${result.kind}`)
      } catch (e) {
        if (e instanceof LlmError && doc) {
          const again = await llm.health()
          if (again.ok) {
            store.saveResult(id, { kind: 'error', error: e.message, model: null }, metaFor(doc))
            this.log.warn(`Document ${id}: ${e.message}`)
            continue
          }
          this.llmDown(again.error)
        } else if (e instanceof LlmError) this.llmDown(e.message)
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

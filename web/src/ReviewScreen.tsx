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

const isDesktop = () => window.matchMedia?.('(min-width: 56.25rem) and (pointer: fine)').matches ?? true

/** YYYY-MM-DD in the browser's locale, without shifting the day by the time zone. */
const formatDate = (isoDate: string) => new Date(`${isoDate}T00:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC' })

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
    onError: (e) => setNotice({ kind: 'failed', text: `Regenerate failed: ${e.message}` }),
  })

  const submit = useCallback(() => {
    if (canApply(edit) && !apply.isPending) apply.mutate(edit)
  }, [edit, apply])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return
      const target = e.target instanceof Element ? e.target : null
      if (e.key === 'Enter') {
        if (target?.closest('button, a, textarea, [data-no-enter-apply]')) return
        if (target?.closest('input, select') && !isDesktop()) return
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
        if (!regenerate.isPending) regenerate.mutate()
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

        <div className="flex flex-col gap-5 desk:flex-row desk:gap-3">
          <div className="flex-1">
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
          <div>
            <label htmlFor="created" className="mb-1 block text-xs uppercase tracking-wide text-gray-500">
              Issue date
            </label>
            <input
              id="created"
              type="date"
              value={edit.created}
              onChange={(e) => setEdit((st) => ({ ...st, created: e.target.value }))}
              className="w-full rounded border border-gray-300 px-2 py-2 desk:w-auto"
            />
            {edit.created && doc.created !== edit.created && (
              <span className="mt-1 block text-xs text-gray-400 line-through">{formatDate(doc.created)}</span>
            )}
          </div>
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

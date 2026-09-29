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
              {t.matchedFrom && <span className="pl-3 text-xs text-gray-500">matched from "{t.matchedFrom}"</span>}
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
                  "{t.name}" doesn't exist yet. Similar:{' '}
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
                  Create new tag "{query.trim()}"
                </button>
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  )
}

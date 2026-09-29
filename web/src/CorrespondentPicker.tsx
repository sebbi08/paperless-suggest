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

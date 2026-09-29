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

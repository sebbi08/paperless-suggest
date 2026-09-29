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

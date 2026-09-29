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

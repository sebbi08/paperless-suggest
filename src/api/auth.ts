import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { Context, MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'

export const SESSION_COOKIE = 'ps_session'
export const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60
const MAX_FAILURES = 10
const FAILURE_WINDOW_MS = 15 * 60 * 1000

export interface AuthOptions {
  password: string | null
  disabled: boolean
  secret: string
  now?: () => number
}

export interface Auth {
  middleware: MiddlewareHandler
  login(c: Context): Promise<Response>
  logout(c: Context): Response
}

const digest = (s: string) => createHash('sha256').update(s).digest()

export function createAuth(opts: AuthOptions): Auth {
  const now = opts.now ?? Date.now
  let failures: number[] = []

  const sign = (exp: number) => createHmac('sha256', opts.secret).update(String(exp)).digest('base64url')

  function isValid(token: string | undefined): boolean {
    if (!token) return false
    const [expPart, sig] = token.split('.')
    const exp = Number(expPart)
    if (!sig || !Number.isInteger(exp) || exp * 1000 < now()) return false
    const expected = Buffer.from(sign(exp))
    const given = Buffer.from(sig)
    return expected.length === given.length && timingSafeEqual(expected, given)
  }

  const isHttps = (c: Context) =>
    new URL(c.req.url).protocol === 'https:' || c.req.header('x-forwarded-proto') === 'https'

  return {
    middleware: async (c, next) => {
      if (opts.disabled || isValid(getCookie(c, SESSION_COOKIE))) return next()
      return c.json({ error: 'unauthorized' }, 401)
    },

    async login(c) {
      if (opts.disabled) return c.json({ ok: true })
      const t = now()
      failures = failures.filter((f) => t - f < FAILURE_WINDOW_MS)
      if (failures.length >= MAX_FAILURES) return c.json({ error: 'Too many attempts, try again later' }, 429)
      const body = (await c.req.json().catch(() => null)) as { password?: unknown } | null
      const password = typeof body?.password === 'string' ? body.password : ''
      if (!opts.password || !timingSafeEqual(digest(password), digest(opts.password))) {
        failures.push(t)
        return c.json({ error: 'Wrong password' }, 401)
      }
      const exp = Math.floor(t / 1000) + SESSION_MAX_AGE_S
      setCookie(c, SESSION_COOKIE, `${exp}.${sign(exp)}`, {
        httpOnly: true,
        sameSite: 'Lax',
        secure: isHttps(c),
        path: '/',
        maxAge: SESSION_MAX_AGE_S,
      })
      return c.json({ ok: true })
    },

    logout(c) {
      deleteCookie(c, SESSION_COOKIE, { path: '/' })
      return c.json({ ok: true })
    },
  }
}

import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { createAuth, type AuthOptions } from '../../src/api/auth'

function setup(opts: Partial<AuthOptions> = {}) {
  let time = Date.parse('2026-09-29T10:00:00Z')
  const auth = createAuth({ password: 'pw', disabled: false, secret: 's3cret', now: () => time, ...opts })
  const app = new Hono()
  app.post('/api/login', (c) => auth.login(c))
  app.post('/api/logout', (c) => auth.logout(c))
  app.use('/api/*', auth.middleware)
  app.get('/api/secret', (c) => c.text('ok'))
  const login = (password: string, headers: Record<string, string> = {}) =>
    app.request('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ password }),
    })
  const secret = (cookie?: string) => app.request('/api/secret', { headers: cookie ? { cookie } : {} })
  return { app, login, secret, advance: (ms: number) => (time += ms) }
}

const cookieOf = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0]!

describe('auth', () => {
  it('lets everything through when disabled', async () => {
    const { secret } = setup({ disabled: true })
    expect((await secret()).status).toBe(200)
  })

  it('rejects requests without a session', async () => {
    const { secret } = setup()
    expect((await secret()).status).toBe(401)
  })

  it('rejects a wrong password', async () => {
    const { login } = setup()
    expect((await login('nope')).status).toBe(401)
  })

  it('issues a 30-day HttpOnly Lax cookie that grants access', async () => {
    const { login, secret } = setup()
    const res = await login('pw')
    expect(res.status).toBe(200)
    const header = res.headers.get('set-cookie') ?? ''
    expect(header).toContain('HttpOnly')
    expect(header).toContain('SameSite=Lax')
    expect(header).toContain('Max-Age=2592000')
    expect(header).toContain('Path=/')
    expect(header).not.toContain('Secure')
    expect((await secret(cookieOf(res))).status).toBe(200)
  })

  it('marks the cookie Secure behind an HTTPS proxy', async () => {
    const { login } = setup()
    const res = await login('pw', { 'x-forwarded-proto': 'https' })
    expect(res.headers.get('set-cookie')).toContain('Secure')
  })

  it('expires sessions after 30 days', async () => {
    const { login, secret, advance } = setup()
    const cookie = cookieOf(await login('pw'))
    advance(31 * 24 * 60 * 60 * 1000)
    expect((await secret(cookie)).status).toBe(401)
  })

  it('rejects tampered cookies', async () => {
    const { login, secret } = setup()
    const cookie = cookieOf(await login('pw'))
    const [name, value] = cookie.split('=')
    const [exp] = value!.split('.')
    expect((await secret(`${name}=${Number(exp) + 999999}.${value!.split('.')[1]}`)).status).toBe(401)
    expect((await secret(`${name}=garbage`)).status).toBe(401)
  })

  it('rate-limits login after 10 failures for 15 minutes', async () => {
    const { login, advance } = setup()
    for (let i = 0; i < 10; i++) expect((await login('nope')).status).toBe(401)
    expect((await login('pw')).status).toBe(429)
    advance(15 * 60 * 1000 + 1)
    expect((await login('pw')).status).toBe(200)
  })

  it('clears the cookie on logout', async () => {
    const { app } = setup()
    const res = await app.request('/api/logout', { method: 'POST' })
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0')
  })
})

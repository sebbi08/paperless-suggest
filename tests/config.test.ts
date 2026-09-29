import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from '../src/config'

const base = {
  PAPERLESS_URL: 'http://paperless:8000/',
  PAPERLESS_TOKEN: 'tok',
  LLM_BASE_URL: 'http://pc:1234/v1/',
  APP_PASSWORD: 'pw',
}

describe('loadConfig', () => {
  it('applies defaults and strips trailing slashes', () => {
    expect(loadConfig(base)).toEqual({
      paperlessUrl: 'http://paperless:8000',
      paperlessToken: 'tok',
      llmBaseUrl: 'http://pc:1234/v1',
      llmModel: null,
      inboxTag: null,
      appPassword: 'pw',
      authDisabled: false,
      pollIntervalSec: 300,
      maxContentChars: 6000,
      newNameMatchThreshold: 0.85,
      dataDir: '/data',
      port: 3000,
    })
  })

  it('names every missing required variable', () => {
    let message = ''
    try {
      loadConfig({})
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError)
      message = (e as Error).message
    }
    expect(message).toContain('PAPERLESS_URL')
    expect(message).toContain('PAPERLESS_TOKEN')
    expect(message).toContain('LLM_BASE_URL')
  })

  it('treats empty strings as missing', () => {
    expect(() => loadConfig({ ...base, PAPERLESS_TOKEN: '  ' })).toThrow(/PAPERLESS_TOKEN/)
  })

  it('requires APP_PASSWORD unless AUTH_DISABLED is true', () => {
    const { APP_PASSWORD: _unused, ...noPassword } = base
    expect(() => loadConfig(noPassword)).toThrow(/APP_PASSWORD/)
    expect(loadConfig({ ...noPassword, AUTH_DISABLED: 'true' }).authDisabled).toBe(true)
  })

  it('does not require APP_PASSWORD when requireAuth is false', () => {
    const { APP_PASSWORD: _unused, ...noPassword } = base
    expect(loadConfig(noPassword, { requireAuth: false }).appPassword).toBeNull()
  })

  it('parses optional values and numeric overrides', () => {
    const c = loadConfig({
      ...base,
      LLM_MODEL: 'qwen3-14b',
      INBOX_TAG: 'Posteingang',
      POLL_INTERVAL: '60',
      MAX_CONTENT_CHARS: '4000',
      NEW_NAME_MATCH_THRESHOLD: '0.9',
      DATA_DIR: './data',
      PORT: '8080',
    })
    expect(c).toMatchObject({
      llmModel: 'qwen3-14b',
      inboxTag: 'Posteingang',
      pollIntervalSec: 60,
      maxContentChars: 4000,
      newNameMatchThreshold: 0.9,
      dataDir: './data',
      port: 8080,
    })
  })

  it('rejects an out-of-range threshold', () => {
    expect(() => loadConfig({ ...base, NEW_NAME_MATCH_THRESHOLD: '1.5' })).toThrow(/NEW_NAME_MATCH_THRESHOLD/)
  })
})

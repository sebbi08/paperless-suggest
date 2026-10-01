import { describe, expect, it } from 'vitest'
import { openDb } from '../../src/store/db'

describe('openDb', () => {
  it('explains which directory could not be opened', () => {
    expect(() => openDb('/nonexistent-dir/paperless-suggest.sqlite')).toThrow(
      /Cannot open database \/nonexistent-dir\/paperless-suggest\.sqlite.*not writable.*uid \d+/,
    )
  })
})

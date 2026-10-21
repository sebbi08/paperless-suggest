import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../../src/store/db'

let dir: string | undefined
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

describe('openDb', () => {
  it('explains which directory could not be opened', () => {
    expect(() => openDb('/nonexistent-dir/paperless-suggest.sqlite')).toThrow(
      /Cannot open database \/nonexistent-dir\/paperless-suggest\.sqlite.*not writable.*uid \d+/,
    )
  })

  it('adds the issue date column and regenerates open suggestions of an older database', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'ps-db-'))
    const file = path.join(dir, 'db.sqlite')
    const old = new Database(file)
    old.exec(`
      CREATE TABLE suggestions (
        document_id INTEGER PRIMARY KEY, status TEXT NOT NULL, in_inbox INTEGER NOT NULL DEFAULT 1,
        added TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0, stale INTEGER NOT NULL DEFAULT 0,
        title TEXT, correspondent_id INTEGER, proposed_correspondent TEXT,
        tag_ids TEXT NOT NULL DEFAULT '[]', proposed_tags TEXT NOT NULL DEFAULT '[]',
        matched_notes TEXT NOT NULL DEFAULT '{}', model TEXT, content_hash TEXT, vocab_hash TEXT,
        doc_modified TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO suggestions (document_id, status, in_inbox, added, created_at, updated_at) VALUES
        (1, 'ready', 1, 'a', 'x', 'x'), (2, 'error', 1, 'a', 'x', 'x'), (3, 'applied', 0, 'a', 'x', 'x'),
        (4, 'no_text', 1, 'a', 'x', 'x');
    `)
    old.close()

    const db = openDb(file)
    const rows = db.prepare('SELECT document_id, stale, created_date FROM suggestions ORDER BY document_id').all()
    expect(rows).toEqual([
      { document_id: 1, stale: 1, created_date: null },
      { document_id: 2, stale: 1, created_date: null },
      { document_id: 3, stale: 0, created_date: null },
      { document_id: 4, stale: 0, created_date: null },
    ])
    db.close()

    const again = openDb(file)
    again.prepare(`UPDATE suggestions SET stale = 0`).run()
    again.close()
    const third = openDb(file)
    expect(third.prepare('SELECT SUM(stale) AS n FROM suggestions').get()).toEqual({ n: 0 })
    third.close()
  })
})

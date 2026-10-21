import Database from 'better-sqlite3'
import path from 'node:path'

export type Db = Database.Database

export function openDb(file: string): Db {
  let db: Db
  try {
    db = new Database(file)
  } catch (e) {
    const uid = process.getuid?.() ?? 'unknown'
    throw new Error(
      `Cannot open database ${file}: directory ${path.dirname(file)} is missing or not writable by uid ${uid} (${(e as Error).message})`,
    )
  }
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS suggestions (
      document_id INTEGER PRIMARY KEY,
      status TEXT NOT NULL,
      in_inbox INTEGER NOT NULL DEFAULT 1,
      added TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      stale INTEGER NOT NULL DEFAULT 0,
      title TEXT,
      created_date TEXT,
      correspondent_id INTEGER,
      proposed_correspondent TEXT,
      tag_ids TEXT NOT NULL DEFAULT '[]',
      proposed_tags TEXT NOT NULL DEFAULT '[]',
      matched_notes TEXT NOT NULL DEFAULT '{}',
      model TEXT,
      content_hash TEXT,
      vocab_hash TEXT,
      doc_modified TEXT,
      error TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS suggestions_queue ON suggestions (in_inbox, status, added, document_id);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `)
  migrate(db)
  return db
}

function hasColumn(db: Db, table: string, column: string): boolean {
  return (db.pragma(`table_info(${table})`) as { name: string }[]).some((c) => c.name === column)
}

function migrate(db: Db): void {
  if (!hasColumn(db, 'suggestions', 'created_date')) {
    db.transaction(() => {
      db.exec('ALTER TABLE suggestions ADD COLUMN created_date TEXT')
      // Suggestions made before the issue date existed are regenerated to get one.
      db.exec(`UPDATE suggestions SET stale = 1 WHERE in_inbox = 1 AND status IN ('ready', 'error')`)
    })()
  }
}

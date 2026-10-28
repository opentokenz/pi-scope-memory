import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { backupPath, databasePath, scopeDataDir } from "./config.ts";

/** Bump together with the DDL below; `PRAGMA user_version` stores it. */
const SCHEMA_VERSION = 2;

export interface MemoryDb {
	scopeId: string;
	path: string;
	sqlite: DatabaseSync;
	closed: boolean;
	txDepth: number;
}

export function openMemoryDb(scopeId: string): MemoryDb {
	const path = databasePath(scopeId);
	mkdirSync(dirname(path), { recursive: true });
	const sqlite = new DatabaseSync(path, { enableForeignKeyConstraints: true, timeout: 5000 });
	const db: MemoryDb = { scopeId, path, sqlite, closed: false, txDepth: 0 };
	sqlite.exec("PRAGMA journal_mode = WAL");
	sqlite.exec("PRAGMA synchronous = NORMAL");
	sqlite.exec("PRAGMA busy_timeout = 5000");
	sqlite.exec("PRAGMA foreign_keys = ON");
	migrate(db);
	return db;
}

export function closeMemoryDb(db: MemoryDb | undefined | null): void {
	if (!db || db.closed) return;
	db.closed = true;
	try {
		if (db.txDepth > 0) {
			db.sqlite.exec("ROLLBACK");
			db.txDepth = 0;
		}
		db.sqlite.exec("PRAGMA optimize");
	} catch {
		// Closing must stay best-effort; a broken pragma must not block shutdown.
	}
	try {
		db.sqlite.close();
	} catch {
		// Already closed or invalid.
	}
}

/** Run `fn` inside one write transaction; nested calls reuse the outer transaction. */
export function withTransaction<T>(db: MemoryDb, fn: () => T): T {
	if (db.txDepth > 0) {
		db.txDepth += 1;
		try {
			return fn();
		} finally {
			db.txDepth -= 1;
		}
	}
	db.sqlite.exec("BEGIN IMMEDIATE");
	db.txDepth = 1;
	try {
		const result = fn();
		db.sqlite.exec("COMMIT");
		return result;
	} catch (error) {
		try {
			db.sqlite.exec("ROLLBACK");
		} catch {
			// Transaction may already be rolled back by SQLite.
		}
		throw error;
	} finally {
		db.txDepth = 0;
	}
}

/** Consistent online backup. Returns the created file path. */
export function backupDatabase(db: MemoryDb): string {
	// A short random suffix keeps two cleanups in the same second from colliding;
	// VACUUM INTO refuses to overwrite an existing file.
	const dest = backupPath(db.scopeId, `${Date.now()}-${randomBytes(2).toString("hex")}`);
	mkdirSync(dirname(dest), { recursive: true });
	// VACUUM INTO reads a consistent snapshot even while WAL is active and
	// refuses to overwrite an existing file.
	db.sqlite.prepare("VACUUM INTO ?").run(dest);
	return dest;
}

export function getMeta(db: MemoryDb, key: string): string | undefined {
	const row = db.sqlite.prepare("SELECT value FROM meta WHERE key = ?").get(key);
	return row ? String(row.value) : undefined;
}

export function setMeta(db: MemoryDb, key: string, value: string): void {
	db.sqlite
		.prepare(
			"INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
		)
		.run(key, value);
}

export function getMetaNumber(db: MemoryDb, key: string, fallback = 0): number {
	const raw = getMeta(db, key);
	if (raw === undefined) return fallback;
	const value = Number(raw);
	return Number.isFinite(value) ? value : fallback;
}

export function incrementMeta(db: MemoryDb, key: string, delta = 1): number {
	const next = getMetaNumber(db, key) + delta;
	setMeta(db, key, String(next));
	return next;
}

export function nowIso(date = new Date()): string {
	return date.toISOString();
}

export function ensureScopeDirectories(scopeId: string): void {
	mkdirSync(scopeDataDir(scopeId), { recursive: true });
}

function migrate(db: MemoryDb): void {
	const row = db.sqlite.prepare("PRAGMA user_version").get();
	const current = row ? Number(row.user_version) : 0;
	if (current === SCHEMA_VERSION) return;
	if (current > SCHEMA_VERSION) {
		throw new Error(`数据库 schema 版本 ${current} 高于当前扩展支持的 ${SCHEMA_VERSION}`);
	}
	if (current === 0) {
		// DDL_V1 still creates the original FTS table; migrateFtsToTrigram
		// immediately replaces it with the trigram index used from version 2 on.
		db.sqlite.exec(DDL_V1);
		db.sqlite.exec("PRAGMA user_version = 1");
		migrateFtsToTrigram(db);
		db.sqlite.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
		return;
	}
	if (current === 1) {
		// Rebuilding the search index is not destructive, but keep the same
		// backup guarantee as any other migration.
		backupDatabase(db);
		migrateFtsToTrigram(db);
		db.sqlite.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
		return;
	}
	throw new Error(`未知的数据库 schema 版本: ${current}`);
}

/**
 * Version 2 switches FTS5 to the trigram tokenizer so long Chinese sentences
 * match without word segmentation. The old triggers stay in place: they are
 * attached to `memories` and only refer to the `memory_fts` table by name.
 */
function migrateFtsToTrigram(db: MemoryDb): void {
	db.sqlite.exec("DROP TABLE IF EXISTS memory_fts");
	db.sqlite.exec(`CREATE VIRTUAL TABLE memory_fts USING fts5(
  title,
  content,
  content='memories',
  content_rowid='rowid',
  tokenize='trigram'
)`);
	db.sqlite.exec("INSERT INTO memory_fts(memory_fts) VALUES('rebuild')");
}

const DDL_V1 = `
CREATE TABLE IF NOT EXISTS memories (
  rowid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  -- NULL means the shared layer; otherwise the repository id.
  repo_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('fact','decision','constraint','pitfall','preference','checkpoint')),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','candidate','review','superseded','expired')),
  source TEXT NOT NULL DEFAULT 'agent' CHECK (source IN ('agent','learning','user')),
  dedupe_key TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  related_paths_json TEXT NOT NULL DEFAULT '[]',
  tags_json TEXT NOT NULL DEFAULT '[]',
  superseded_by TEXT REFERENCES memories(id) ON DELETE SET NULL,
  supersedes TEXT,
  confidence REAL NOT NULL DEFAULT 1,
  expires_at TEXT,
  verified_at TEXT,
  rev INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(repo_id, status);
CREATE INDEX IF NOT EXISTS idx_memories_dedupe ON memories(dedupe_key);
CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at);

CREATE TABLE IF NOT EXISTS memory_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_revisions_memory ON memory_revisions(memory_id);

CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  processed INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_observations_pending ON observations(processed, created_at);

CREATE TABLE IF NOT EXISTS usage_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  source TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_source_time ON usage_stats(source, created_at);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  title,
  content,
  content='memories',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memory_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
END;

CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content);
END;

CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content);
  INSERT INTO memory_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
END;
`;

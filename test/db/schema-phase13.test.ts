import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/db.js';

/**
 * Phase 13 Wave 0: RED DDL tests for conversations/sessions/settings tables.
 *
 * These tests verify that createTestDb() creates the Phase 13 tables with
 * the expected schema, FK constraints, indexes, and seed data.
 *
 * The tests run against the in-memory test DB (createTestDb) which mirrors
 * the production schema. When Wave 1 (Plan 02) adds these tables to
 * src/db/index.ts migrateSchema, the production DB will match.
 */

describe('Phase 13 schema DDL', () => {
	it('createDb creates sessions, conversations, and settings tables', () => {
		const db = createTestDb();
		const tables = db.$client
			.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
			.all() as { name: string }[];
		const tableNames = tables.map((t) => t.name);

		expect(tableNames).toContain('sessions');
		expect(tableNames).toContain('conversations');
		expect(tableNames).toContain('settings');
	});

	it('conversations has FK to sessions.id with ON DELETE CASCADE', () => {
		const db = createTestDb();
		const fks = db.$client.pragma('foreign_key_list(conversations)') as Array<{
			table: string;
			from: string;
			to: string;
			on_delete: string;
		}>;

		const sessionFk = fks.find((fk) => fk.table === 'sessions');
		expect(sessionFk).toBeDefined();
		expect(sessionFk?.from).toBe('session_id');
		expect(sessionFk?.to).toBe('id');
		expect(sessionFk?.on_delete).toBe('CASCADE');
	});

	it('idx_conversations_created_at and idx_conversations_session_id indexes exist', () => {
		const db = createTestDb();
		const indexes = db.$client
			.prepare(
				"SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_conversations_%'",
			)
			.all() as { name: string }[];
		const indexNames = indexes.map((i) => i.name);

		expect(indexNames).toContain('idx_conversations_created_at');
		expect(indexNames).toContain('idx_conversations_session_id');
		expect(indexes.length).toBe(2);
	});

	it('settings seed row id=1 first_boot_shown=0 exists after createDb', () => {
		const db = createTestDb();
		const row = db.$client.prepare('SELECT * FROM settings WHERE id = 1').get() as {
			id: number;
			first_boot_shown: number;
		};

		expect(row).toBeDefined();
		expect(row.id).toBe(1);
		expect(row.first_boot_shown).toBe(0);
	});

	it('re-running table creation is idempotent (no errors, settings row unchanged)', () => {
		const db = createTestDb();

		// Update settings to first_boot_shown=1 to verify it is NOT overwritten
		db.$client.prepare('UPDATE settings SET first_boot_shown = 1 WHERE id = 1').run();

		// Re-run the same DDL (simulating a second migration run)
		db.$client.exec(`
			CREATE TABLE IF NOT EXISTS sessions (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				started_at TEXT NOT NULL DEFAULT (datetime('now')),
				ended_at TEXT
			);
			CREATE TABLE IF NOT EXISTS conversations (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				role TEXT NOT NULL,
				content TEXT NOT NULL,
				created_at TEXT NOT NULL DEFAULT (datetime('now')),
				classifier_intent TEXT,
				triggered_by TEXT,
				session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE
			);
			CREATE INDEX IF NOT EXISTS idx_conversations_created_at ON conversations(created_at);
			CREATE INDEX IF NOT EXISTS idx_conversations_session_id ON conversations(session_id);
			CREATE TABLE IF NOT EXISTS settings (
				id INTEGER PRIMARY KEY,
				first_boot_shown INTEGER NOT NULL DEFAULT 0
			);
			INSERT OR IGNORE INTO settings (id, first_boot_shown) VALUES (1, 0);
		`);

		// Settings row should still have first_boot_shown=1 (INSERT OR IGNORE skips)
		const row = db.$client.prepare('SELECT first_boot_shown FROM settings WHERE id = 1').get() as {
			first_boot_shown: number;
		};
		expect(row.first_boot_shown).toBe(1);
	});
});

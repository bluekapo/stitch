import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../../src/db/schema.js';

export function createTestDb() {
	const sqlite = new Database(':memory:');
	sqlite.pragma('foreign_keys = ON');
	// Mirror src/db/schema.ts tables -- keep in sync manually
	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS tasks (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT NOT NULL,
			description TEXT,
			status TEXT NOT NULL DEFAULT 'pending',
			is_essential INTEGER NOT NULL DEFAULT 0,
			postpone_count INTEGER NOT NULL DEFAULT 0,
			timer_started_at TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE TABLE IF NOT EXISTS task_durations (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
			duration_seconds INTEGER NOT NULL,
			started_at TEXT NOT NULL,
			ended_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
	`);
	return drizzle(sqlite, { schema });
}

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

export type StitchDb = ReturnType<typeof createDb>;

export function createDb(dbPath: string) {
	if (dbPath !== ':memory:') {
		mkdirSync(dirname(dbPath), { recursive: true });
	}
	const sqlite = new Database(dbPath);
	sqlite.pragma('journal_mode = WAL');
	migrateSchema(sqlite);
	migrateBlueprintSchema(sqlite);
	migrateDailyPlanSchema(sqlite);
	return drizzle(sqlite, { schema });
}

/** Add columns introduced after initial schema. Only alters what's missing. */
function migrateSchema(sqlite: Database.Database) {
	const existing = new Set(
		(sqlite.pragma('table_info(tasks)') as { name: string }[]).map((c) => c.name),
	);
	const additions: [string, string][] = [
		['task_type', `TEXT NOT NULL DEFAULT 'ad-hoc'`],
		['recurrence_day', 'INTEGER'],
		['deadline', 'TEXT'],
		['source_task_id', 'INTEGER REFERENCES tasks(id) ON DELETE SET NULL'],
	];
	for (const [col, def] of additions) {
		if (!existing.has(col)) {
			sqlite.exec(`ALTER TABLE tasks ADD COLUMN ${col} ${def}`);
		}
	}
}

/** Create daily plan tables if they don't exist yet. */
function migrateDailyPlanSchema(sqlite: Database.Database) {
	const row = sqlite
		.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='daily_plans'")
		.get() as { name: string } | undefined;
	if (row) return;

	sqlite.exec(`
		CREATE TABLE daily_plans (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			date TEXT NOT NULL UNIQUE,
			blueprint_id INTEGER NOT NULL REFERENCES blueprints(id),
			status TEXT NOT NULL DEFAULT 'active',
			llm_reasoning TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE TABLE plan_chunks (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			plan_id INTEGER NOT NULL REFERENCES daily_plans(id) ON DELETE CASCADE,
			task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
			label TEXT NOT NULL,
			start_time TEXT NOT NULL,
			end_time TEXT NOT NULL,
			is_locked INTEGER NOT NULL DEFAULT 0,
			sort_order INTEGER NOT NULL DEFAULT 0,
			status TEXT NOT NULL DEFAULT 'pending'
		);
	`);
}

/** Create blueprint tables if they don't exist yet. */
function migrateBlueprintSchema(sqlite: Database.Database) {
	const row = sqlite
		.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='blueprints'")
		.get() as { name: string } | undefined;
	if (row) return;

	sqlite.exec(`
		CREATE TABLE blueprints (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT NOT NULL,
			is_active INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE TABLE blueprint_cycles (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			blueprint_id INTEGER NOT NULL REFERENCES blueprints(id) ON DELETE CASCADE,
			name TEXT NOT NULL,
			sort_order INTEGER NOT NULL DEFAULT 0,
			start_time TEXT NOT NULL,
			end_time TEXT NOT NULL
		);
		CREATE TABLE blueprint_time_blocks (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			cycle_id INTEGER NOT NULL REFERENCES blueprint_cycles(id) ON DELETE CASCADE,
			label TEXT,
			start_time TEXT NOT NULL,
			end_time TEXT NOT NULL,
			is_slot INTEGER NOT NULL DEFAULT 1,
			sort_order INTEGER NOT NULL DEFAULT 0
		);
	`);
}

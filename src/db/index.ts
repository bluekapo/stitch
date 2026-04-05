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
	migrateDayTreeSchema(sqlite);
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

/** Create or upgrade daily plan tables. */
function migrateDailyPlanSchema(sqlite: Database.Database) {
	const tableExists = sqlite
		.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='daily_plans'")
		.get() as { name: string } | undefined;

	if (!tableExists) {
		sqlite.exec(`
			CREATE TABLE daily_plans (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				date TEXT NOT NULL UNIQUE,
				blueprint_id INTEGER REFERENCES blueprints(id),
				day_tree_id INTEGER,
				status TEXT NOT NULL DEFAULT 'active',
				llm_reasoning TEXT,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			);
			CREATE TABLE plan_chunks (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				plan_id INTEGER NOT NULL REFERENCES daily_plans(id) ON DELETE CASCADE,
				task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
				cycle_name TEXT NOT NULL DEFAULT '',
				label TEXT NOT NULL,
				start_time TEXT NOT NULL,
				end_time TEXT NOT NULL,
				is_locked INTEGER NOT NULL DEFAULT 0,
				is_task_slot INTEGER NOT NULL DEFAULT 1,
				sort_order INTEGER NOT NULL DEFAULT 0,
				status TEXT NOT NULL DEFAULT 'pending'
			);
			CREATE TABLE chunk_tasks (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				chunk_id INTEGER NOT NULL REFERENCES plan_chunks(id) ON DELETE CASCADE,
				task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
				label TEXT NOT NULL,
				is_locked INTEGER NOT NULL DEFAULT 0,
				sort_order INTEGER NOT NULL DEFAULT 0,
				status TEXT NOT NULL DEFAULT 'pending'
			);
		`);
		return;
	}

	// Upgrade existing tables: add Phase 08.1 columns if missing
	const planCols = new Set(
		(sqlite.pragma('table_info(daily_plans)') as { name: string }[]).map((c) => c.name),
	);
	if (!planCols.has('day_tree_id')) {
		sqlite.exec('ALTER TABLE daily_plans ADD COLUMN day_tree_id INTEGER');
	}

	const chunkCols = new Set(
		(sqlite.pragma('table_info(plan_chunks)') as { name: string }[]).map((c) => c.name),
	);
	if (!chunkCols.has('cycle_name')) {
		sqlite.exec(`ALTER TABLE plan_chunks ADD COLUMN cycle_name TEXT NOT NULL DEFAULT ''`);
	}
	if (!chunkCols.has('is_task_slot')) {
		sqlite.exec('ALTER TABLE plan_chunks ADD COLUMN is_task_slot INTEGER NOT NULL DEFAULT 1');
	}

	// Create chunk_tasks table if missing
	const chunkTasksExists = sqlite
		.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chunk_tasks'")
		.get();
	if (!chunkTasksExists) {
		sqlite.exec(`
			CREATE TABLE chunk_tasks (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				chunk_id INTEGER NOT NULL REFERENCES plan_chunks(id) ON DELETE CASCADE,
				task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
				label TEXT NOT NULL,
				is_locked INTEGER NOT NULL DEFAULT 0,
				sort_order INTEGER NOT NULL DEFAULT 0,
				status TEXT NOT NULL DEFAULT 'pending'
			);
		`);
	}
}

/** Create day_trees table if it doesn't exist yet. */
function migrateDayTreeSchema(sqlite: Database.Database) {
	const row = sqlite
		.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='day_trees'")
		.get() as { name: string } | undefined;
	if (row) return;

	sqlite.exec(`
		CREATE TABLE day_trees (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			tree TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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

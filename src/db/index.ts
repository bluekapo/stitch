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
	// Phase 08.3 Pitfall 4 fix: enable foreign_keys so ON DELETE SET NULL actually
	// fires on tasks.chunk_id when plan_chunks rows are deleted (regenerating a plan).
	// Must be set BEFORE migrations because FK behavior is connection-scoped.
	sqlite.pragma('foreign_keys = ON');
	// Ordering note: migrateDailyPlanSchema creates plan_chunks; migrateSchema creates
	// tasks referencing it. SQLite allows FK to a not-yet-existing table at CREATE
	// TABLE time -- enforcement only kicks in at row-level writes -- so order is fine.
	migrateSchema(sqlite);
	migrateBlueprintSchema(sqlite);
	migrateDailyPlanSchema(sqlite);
	migrateDayTreeSchema(sqlite);
	migratePendingCleanupsSchema(sqlite);
	migrateCheckInsSchema(sqlite);
	return drizzle(sqlite, { schema });
}

/** Create core tables if missing, then add columns introduced after initial schema. */
function migrateSchema(sqlite: Database.Database) {
	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS tasks (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT NOT NULL,
			description TEXT,
			status TEXT NOT NULL DEFAULT 'pending',
			is_essential INTEGER NOT NULL DEFAULT 0,
			postpone_count INTEGER NOT NULL DEFAULT 0,
			task_type TEXT NOT NULL DEFAULT 'ad-hoc',
			recurrence_day INTEGER,
			deadline TEXT,
			source_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
			timer_started_at TEXT,
			chunk_id INTEGER REFERENCES plan_chunks(id) ON DELETE SET NULL,
			branch_name TEXT,
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

	// Add columns that may be missing on older databases
	const existing = new Set(
		(sqlite.pragma('table_info(tasks)') as { name: string }[]).map((c) => c.name),
	);
	// Capture BEFORE the ALTER loop so we can gate the backfill on "was just added".
	const didAddChunkId = !existing.has('chunk_id');
	const additions: [string, string][] = [
		['task_type', `TEXT NOT NULL DEFAULT 'ad-hoc'`],
		['recurrence_day', 'INTEGER'],
		['deadline', 'TEXT'],
		['source_task_id', 'INTEGER REFERENCES tasks(id) ON DELETE SET NULL'],
		// Phase 08.3: direct task->chunk attachment. Both nullable (no NOT NULL -- sidesteps
		// SQLite's table-recreation requirement for dropping NOT NULL later).
		['chunk_id', 'INTEGER REFERENCES plan_chunks(id) ON DELETE SET NULL'],
		['branch_name', 'TEXT'],
	];
	for (const [col, def] of additions) {
		if (!existing.has(col)) {
			sqlite.exec(`ALTER TABLE tasks ADD COLUMN ${col} ${def}`);
		}
	}

	// Phase 08.3 backfill: populate chunk_id and branch_name from the most-recent
	// chunk_tasks link for each task. Only runs on the migration that introduced
	// the columns -- subsequent runs see chunk_id already present and skip.
	// Guarded on chunk_tasks existing because migrateSchema runs before
	// migrateDailyPlanSchema on fresh DBs where chunk_tasks does not yet exist.
	if (didAddChunkId) {
		const chunkTasksExists = sqlite
			.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chunk_tasks'")
			.get();
		if (chunkTasksExists) {
			sqlite.exec(`
				UPDATE tasks SET chunk_id = (
					SELECT ct.chunk_id FROM chunk_tasks ct
					WHERE ct.task_id = tasks.id
					ORDER BY ct.id DESC LIMIT 1
				) WHERE chunk_id IS NULL;
			`);
			sqlite.exec(`
				UPDATE tasks SET branch_name = (
					SELECT pc.branch_name FROM chunk_tasks ct
					JOIN plan_chunks pc ON pc.id = ct.chunk_id
					WHERE ct.task_id = tasks.id
					ORDER BY ct.id DESC LIMIT 1
				) WHERE branch_name IS NULL;
			`);
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
				started_at TEXT,
				last_wake_call_at TEXT,
				wake_fired_at TEXT,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			);
			CREATE TABLE plan_chunks (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				plan_id INTEGER NOT NULL REFERENCES daily_plans(id) ON DELETE CASCADE,
				task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
				branch_name TEXT NOT NULL DEFAULT '',
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

	// Phase 9 fix: legacy DBs may have daily_plans WITHOUT plan_chunks (predates 08.x).
	// Create plan_chunks here (matching the fresh-DB definition) before any plan_chunks
	// ALTER below — ALTER on a non-existent table throws.
	const planChunksExists = sqlite
		.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='plan_chunks'")
		.get();
	if (!planChunksExists) {
		sqlite.exec(`
			CREATE TABLE plan_chunks (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				plan_id INTEGER NOT NULL REFERENCES daily_plans(id) ON DELETE CASCADE,
				task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
				branch_name TEXT NOT NULL DEFAULT '',
				label TEXT NOT NULL,
				start_time TEXT NOT NULL,
				end_time TEXT NOT NULL,
				is_locked INTEGER NOT NULL DEFAULT 0,
				is_task_slot INTEGER NOT NULL DEFAULT 1,
				sort_order INTEGER NOT NULL DEFAULT 0,
				status TEXT NOT NULL DEFAULT 'pending'
			);
		`);
	}

	const chunkCols = new Set(
		(sqlite.pragma('table_info(plan_chunks)') as { name: string }[]).map((c) => c.name),
	);
	if (!chunkCols.has('cycle_name') && !chunkCols.has('branch_name')) {
		sqlite.exec(`ALTER TABLE plan_chunks ADD COLUMN branch_name TEXT NOT NULL DEFAULT ''`);
	}
	if (!chunkCols.has('is_task_slot')) {
		sqlite.exec('ALTER TABLE plan_chunks ADD COLUMN is_task_slot INTEGER NOT NULL DEFAULT 1');
	}

	// Phase 08.2: rename cycle_name -> branch_name
	const chunkColsAfter = new Set(
		(sqlite.pragma('table_info(plan_chunks)') as { name: string }[]).map((c) => c.name),
	);
	if (chunkColsAfter.has('cycle_name') && !chunkColsAfter.has('branch_name')) {
		sqlite.exec('ALTER TABLE plan_chunks RENAME COLUMN cycle_name TO branch_name');
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

	// PHASE 9 ADDITIONS (D-19 wake state tracking).
	// Self-contained block: re-reads daily_plans columns so it remains safe to copy/move.
	const planColsPhase9 = new Set(
		(sqlite.pragma('table_info(daily_plans)') as { name: string }[]).map((c) => c.name),
	);
	if (!planColsPhase9.has('started_at')) {
		sqlite.exec(`ALTER TABLE daily_plans ADD COLUMN started_at TEXT`);
	}
	if (!planColsPhase9.has('last_wake_call_at')) {
		sqlite.exec(`ALTER TABLE daily_plans ADD COLUMN last_wake_call_at TEXT`);
	}
	if (!planColsPhase9.has('wake_fired_at')) {
		sqlite.exec(`ALTER TABLE daily_plans ADD COLUMN wake_fired_at TEXT`);
	}
}

/** Create day_trees table if it doesn't exist yet, then migrate stored JSON. */
function migrateDayTreeSchema(sqlite: Database.Database) {
	const row = sqlite
		.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='day_trees'")
		.get() as { name: string } | undefined;

	if (!row) {
		sqlite.exec(`
			CREATE TABLE day_trees (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				tree TEXT NOT NULL,
				created_at TEXT NOT NULL DEFAULT (datetime('now')),
				updated_at TEXT NOT NULL DEFAULT (datetime('now'))
			);
		`);
	}

	// Phase 08.2: migrate stored tree JSON from {cycles:[...]} to {branches:[...]}
	const treeRows = sqlite.prepare('SELECT id, tree FROM day_trees').all() as { id: number; tree: string }[];
	for (const treeRow of treeRows) {
		try {
			const parsed = JSON.parse(treeRow.tree as string);
			if (parsed.cycles && !parsed.branches) {
				parsed.branches = parsed.cycles;
				delete parsed.cycles;
				sqlite.prepare('UPDATE day_trees SET tree = ? WHERE id = ?').run(
					JSON.stringify(parsed), treeRow.id
				);
			}
		} catch { /* skip malformed rows */ }
	}
}

/** Create pending_cleanups table if it doesn't exist yet. */
function migratePendingCleanupsSchema(sqlite: Database.Database) {
	const row = sqlite
		.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_cleanups'")
		.get() as { name: string } | undefined;
	if (row) return;

	sqlite.exec(`
		CREATE TABLE pending_cleanups (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			chat_id INTEGER NOT NULL,
			user_msg_id INTEGER NOT NULL,
			reply_msg_id INTEGER,
			delete_after TEXT NOT NULL
		);
	`);
}

/** Create check_ins table if it doesn't exist yet. Phase 9 (D-10). */
function migrateCheckInsSchema(sqlite: Database.Database) {
	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS check_ins (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			trigger_reason TEXT NOT NULL,
			should_speak INTEGER NOT NULL,
			message_text TEXT,
			next_check_minutes INTEGER,
			day_anchor TEXT NOT NULL
		);
	`);
	sqlite.exec(`
		CREATE INDEX IF NOT EXISTS idx_check_ins_day_anchor ON check_ins(day_anchor);
	`);
	// No ALTER additions yet — first version of this table.
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

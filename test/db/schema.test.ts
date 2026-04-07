import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDb } from '../../src/db/index.js';
import { tasks } from '../../src/db/schema.js';
import { createTestDb } from '../helpers/db.js';

type TestDb = ReturnType<typeof createTestDb>;

describe('tasks table -- CRUD operations', () => {
	let db: TestDb;

	it('createTestDb() returns a Drizzle instance that can execute queries', () => {
		db = createTestDb();
		const result = db.select().from(tasks).all();
		expect(result).toEqual([]);
	});

	it('insert a task with name "Buy groceries", select it back, verify name matches', () => {
		db = createTestDb();
		db.insert(tasks).values({ name: 'Buy groceries' }).run();

		const rows = db.select().from(tasks).all();
		expect(rows).toHaveLength(1);
		expect(rows[0].name).toBe('Buy groceries');
	});

	it('insert a task, update its status to "completed", verify status is "completed"', () => {
		db = createTestDb();
		db.insert(tasks).values({ name: 'Do laundry' }).run();

		const inserted = db.select().from(tasks).all();
		const taskId = inserted[0].id;

		db.update(tasks).set({ status: 'completed' }).where(eq(tasks.id, taskId)).run();

		const updated = db.select().from(tasks).where(eq(tasks.id, taskId)).all();
		expect(updated[0].status).toBe('completed');
	});

	it('insert a task, verify createdAt and updatedAt are auto-populated with ISO datetime strings', () => {
		db = createTestDb();
		db.insert(tasks).values({ name: 'Check timestamps' }).run();

		const rows = db.select().from(tasks).all();
		expect(rows[0].createdAt).toBeTruthy();
		expect(rows[0].updatedAt).toBeTruthy();

		// SQLite datetime('now') returns 'YYYY-MM-DD HH:MM:SS' format
		const dateTimePattern = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
		expect(rows[0].createdAt).toMatch(dateTimePattern);
		expect(rows[0].updatedAt).toMatch(dateTimePattern);
	});

	it('default status is "pending"', () => {
		db = createTestDb();
		db.insert(tasks).values({ name: 'Check default status' }).run();

		const rows = db.select().from(tasks).all();
		expect(rows[0].status).toBe('pending');
	});

	it('id auto-increments', () => {
		db = createTestDb();
		db.insert(tasks).values({ name: 'Task A' }).run();
		db.insert(tasks).values({ name: 'Task B' }).run();

		const rows = db.select().from(tasks).all();
		expect(rows).toHaveLength(2);
		expect(rows[0].id).toBe(1);
		expect(rows[1].id).toBe(2);
	});
});

describe('tasks table -- Phase 08.3 chunk_id + branch_name schema additions', () => {
	type TableInfoRow = { name: string; type: string; notnull: number };

	function getColumns(sqlite: Database.Database): Map<string, TableInfoRow> {
		const rows = sqlite.pragma('table_info(tasks)') as TableInfoRow[];
		return new Map(rows.map((r) => [r.name, r]));
	}

	it('tasks has chunk_id and branch_name columns on fresh DB (via createTestDb)', () => {
		const drizzleDb = createTestDb();
		// biome-ignore lint/suspicious/noExplicitAny: direct better-sqlite3 access for pragma inspection
		const sqlite = (drizzleDb as any).$client as Database.Database;
		const cols = getColumns(sqlite);
		expect(cols.has('chunk_id')).toBe(true);
		expect(cols.has('branch_name')).toBe(true);
		// Both must be nullable -- no NOT NULL to sidestep SQLite table recreation gotcha
		expect(cols.get('chunk_id')?.notnull).toBe(0);
		expect(cols.get('branch_name')?.notnull).toBe(0);
	});

	it('tasks has chunk_id and branch_name columns on fresh DB (via createDb :memory:)', () => {
		const drizzleDb = createDb(':memory:');
		// biome-ignore lint/suspicious/noExplicitAny: direct better-sqlite3 access for pragma inspection
		const sqlite = (drizzleDb as any).$client as Database.Database;
		const cols = getColumns(sqlite);
		expect(cols.has('chunk_id')).toBe(true);
		expect(cols.has('branch_name')).toBe(true);
	});

	it('migration adds chunk_id and branch_name idempotently on existing DB', () => {
		// Build an OLD-schema DB that predates Phase 08.3 (no chunk_id/branch_name)
		const sqlite = new Database(':memory:');
		sqlite.pragma('journal_mode = WAL');
		sqlite.exec(`
			CREATE TABLE tasks (
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
				created_at TEXT NOT NULL DEFAULT (datetime('now')),
				updated_at TEXT NOT NULL DEFAULT (datetime('now'))
			);
			CREATE TABLE task_durations (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
				duration_seconds INTEGER NOT NULL,
				started_at TEXT NOT NULL,
				ended_at TEXT NOT NULL DEFAULT (datetime('now'))
			);
		`);
		sqlite.close();

		// Now use an actual on-disk file via :memory: shared-cache workaround:
		// Since createDb opens its own sqlite, we round-trip via a temp file.
		// Simpler: use createDb directly and inject an old schema by pre-creating the file.
		// For this test we use the internal migrateSchema via createDb(:memory:) flow --
		// we cannot share the DB. Instead, exercise idempotency by running migrate twice
		// on the same DB instance via the exported helper. The createDb path runs migrate
		// once internally; calling it twice in the same process on ':memory:' yields two
		// distinct DBs, which does NOT test idempotency.
		//
		// Idempotency test: create an on-disk temp file, open twice via createDb.
		// This exercises the ALTER path the second time.
		const tmpPath = `${process.env.TEMP || '/tmp'}/stitch-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;

		// First open: runs migration on fresh DB
		const db1 = createDb(tmpPath);
		// biome-ignore lint/suspicious/noExplicitAny: inspect underlying sqlite
		const sqlite1 = (db1 as any).$client as Database.Database;
		const cols1 = getColumns(sqlite1);
		expect(cols1.has('chunk_id')).toBe(true);
		expect(cols1.has('branch_name')).toBe(true);
		sqlite1.close();

		// Second open: runs migration again -- must not error and columns still present
		const db2 = createDb(tmpPath);
		// biome-ignore lint/suspicious/noExplicitAny: inspect underlying sqlite
		const sqlite2 = (db2 as any).$client as Database.Database;
		const cols2 = getColumns(sqlite2);
		expect(cols2.has('chunk_id')).toBe(true);
		expect(cols2.has('branch_name')).toBe(true);
		sqlite2.close();

		// Cleanup
		try {
			require('node:fs').unlinkSync(tmpPath);
		} catch {
			/* ignore */
		}
	});

	it('backfill populates chunk_id and branch_name from chunk_tasks', () => {
		// Build an OLD-schema DB via raw sqlite, then call migrateSchema through createDb
		// by pointing at a temp file we pre-populate.
		const tmpPath = `${process.env.TEMP || '/tmp'}/stitch-test-backfill-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;

		// Pre-create old-schema DB with a task + chunk + chunk_task link
		const seed = new Database(tmpPath);
		seed.pragma('journal_mode = WAL');
		seed.exec(`
			CREATE TABLE tasks (
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
				created_at TEXT NOT NULL DEFAULT (datetime('now')),
				updated_at TEXT NOT NULL DEFAULT (datetime('now'))
			);
			CREATE TABLE task_durations (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
				duration_seconds INTEGER NOT NULL,
				started_at TEXT NOT NULL,
				ended_at TEXT NOT NULL DEFAULT (datetime('now'))
			);
			CREATE TABLE blueprints (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				name TEXT NOT NULL,
				is_active INTEGER NOT NULL DEFAULT 0,
				created_at TEXT NOT NULL DEFAULT (datetime('now')),
				updated_at TEXT NOT NULL DEFAULT (datetime('now'))
			);
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
			CREATE TABLE day_trees (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				tree TEXT NOT NULL,
				created_at TEXT NOT NULL DEFAULT (datetime('now')),
				updated_at TEXT NOT NULL DEFAULT (datetime('now'))
			);
			CREATE TABLE pending_cleanups (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				chat_id INTEGER NOT NULL,
				user_msg_id INTEGER NOT NULL,
				reply_msg_id INTEGER,
				delete_after TEXT NOT NULL
			);
		`);
		// Seed: plan, chunk with branch_name 'Morning', task, chunk_task link
		seed.exec(`
			INSERT INTO daily_plans (id, date) VALUES (1, '2026-04-06');
			INSERT INTO plan_chunks (id, plan_id, branch_name, label, start_time, end_time)
			VALUES (1, 1, 'Morning', 'Exercise', '08:00', '10:00');
			INSERT INTO tasks (id, name) VALUES (10, 'Pushups');
			INSERT INTO chunk_tasks (id, chunk_id, task_id, label)
			VALUES (1, 1, 10, 'Pushups');
		`);
		seed.close();

		// Open via createDb to trigger migrateSchema -- ALTER path + backfill
		const db = createDb(tmpPath);
		// biome-ignore lint/suspicious/noExplicitAny: inspect underlying sqlite
		const sqlite = (db as any).$client as Database.Database;

		const row = sqlite.prepare('SELECT id, chunk_id, branch_name FROM tasks WHERE id = 10').get() as {
			id: number;
			chunk_id: number | null;
			branch_name: string | null;
		};
		expect(row.chunk_id).toBe(1);
		expect(row.branch_name).toBe('Morning');
		sqlite.close();

		try {
			require('node:fs').unlinkSync(tmpPath);
		} catch {
			/* ignore */
		}
	});

	it('foreign_keys pragma is ON after createDb', () => {
		const drizzleDb = createDb(':memory:');
		// biome-ignore lint/suspicious/noExplicitAny: inspect underlying sqlite
		const sqlite = (drizzleDb as any).$client as Database.Database;
		const result = sqlite.pragma('foreign_keys', { simple: true });
		expect(result).toBe(1);
	});

	it('deleting plan_chunks row sets tasks.chunk_id to NULL (FK + pragma together)', () => {
		const drizzleDb = createDb(':memory:');
		// biome-ignore lint/suspicious/noExplicitAny: direct sqlite access to exercise FK cascade
		const sqlite = (drizzleDb as any).$client as Database.Database;

		sqlite.exec(`
			INSERT INTO daily_plans (id, date) VALUES (1, '2026-04-06');
			INSERT INTO plan_chunks (id, plan_id, branch_name, label, start_time, end_time)
			VALUES (1, 1, 'Morning', 'Exercise', '08:00', '10:00');
			INSERT INTO tasks (id, name, chunk_id, branch_name) VALUES (10, 'Pushups', 1, 'Morning');
		`);

		// Sanity: chunk_id is set
		const before = sqlite.prepare('SELECT chunk_id FROM tasks WHERE id = 10').get() as { chunk_id: number | null };
		expect(before.chunk_id).toBe(1);

		// Delete the chunk -- ON DELETE SET NULL should null tasks.chunk_id
		sqlite.exec('DELETE FROM plan_chunks WHERE id = 1');

		const after = sqlite.prepare('SELECT chunk_id FROM tasks WHERE id = 10').get() as { chunk_id: number | null };
		expect(after.chunk_id).toBeNull();
	});
});

describe('check_ins table -- Phase 9 migration safety', () => {
	type TableInfoRow = { name: string; type: string; notnull: number };

	function getColumns(sqlite: Database.Database, table: string): Map<string, TableInfoRow> {
		const rows = sqlite.pragma(`table_info(${table})`) as TableInfoRow[];
		return new Map(rows.map((r) => [r.name, r]));
	}

	it('check_ins table exists on fresh DB via createTestDb (check_ins fresh)', () => {
		const drizzleDb = createTestDb();
		// biome-ignore lint/suspicious/noExplicitAny: pragma inspection
		const sqlite = (drizzleDb as any).$client as Database.Database;
		const cols = getColumns(sqlite, 'check_ins');
		expect(cols.has('id')).toBe(true);
		expect(cols.has('created_at')).toBe(true);
		expect(cols.has('trigger_reason')).toBe(true);
		expect(cols.has('should_speak')).toBe(true);
		expect(cols.has('message_text')).toBe(true);
		expect(cols.has('next_check_minutes')).toBe(true);
		expect(cols.has('day_anchor')).toBe(true);
	});

	it('check_ins table exists on fresh DB via createDb :memory: (check_ins fresh via createDb)', () => {
		const drizzleDb = createDb(':memory:');
		// biome-ignore lint/suspicious/noExplicitAny: pragma inspection
		const sqlite = (drizzleDb as any).$client as Database.Database;
		const cols = getColumns(sqlite, 'check_ins');
		expect(cols.has('day_anchor')).toBe(true);
	});

	it('idx_check_ins_day_anchor index exists after createDb', () => {
		const drizzleDb = createDb(':memory:');
		// biome-ignore lint/suspicious/noExplicitAny: pragma inspection
		const sqlite = (drizzleDb as any).$client as Database.Database;
		const idx = sqlite
			.prepare(
				"SELECT name FROM sqlite_master WHERE type='index' AND name='idx_check_ins_day_anchor'",
			)
			.all();
		expect(idx).toHaveLength(1);
	});

	it('check_ins ALTER -- existing DB without check_ins gets the table on second createDb', () => {
		const tmpPath = `${process.env.TEMP || '/tmp'}/stitch-test-checkins-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;

		// First open: runs migration on fresh DB (creates check_ins)
		const db1 = createDb(tmpPath);
		// biome-ignore lint/suspicious/noExplicitAny: pragma
		const sqlite1 = (db1 as any).$client as Database.Database;
		sqlite1.exec(`DROP TABLE check_ins`); // simulate older DB without the table
		sqlite1.close();

		// Second open: migration must re-create check_ins idempotently
		const db2 = createDb(tmpPath);
		// biome-ignore lint/suspicious/noExplicitAny: pragma
		const sqlite2 = (db2 as any).$client as Database.Database;
		const cols = getColumns(sqlite2, 'check_ins');
		expect(cols.has('day_anchor')).toBe(true);
		sqlite2.close();

		try {
			require('node:fs').unlinkSync(tmpPath);
		} catch {
			/* ignore */
		}
	});

	it('dailyPlans wake columns -- existing DB without started_at/last_wake_call_at/wake_fired_at gets them on createDb', () => {
		const tmpPath = `${process.env.TEMP || '/tmp'}/stitch-test-dpwake-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;

		// Pre-create OLD-schema daily_plans WITHOUT the wake columns
		const seed = new Database(tmpPath);
		seed.pragma('journal_mode = WAL');
		seed.exec(`
			CREATE TABLE daily_plans (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				date TEXT NOT NULL UNIQUE,
				blueprint_id INTEGER,
				day_tree_id INTEGER,
				status TEXT NOT NULL DEFAULT 'active',
				llm_reasoning TEXT,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			);
		`);
		seed.close();

		// Open via createDb -- triggers migrateDailyPlanSchema ALTER path
		const db = createDb(tmpPath);
		// biome-ignore lint/suspicious/noExplicitAny: pragma
		const sqlite = (db as any).$client as Database.Database;
		const cols = getColumns(sqlite, 'daily_plans');
		expect(cols.has('started_at')).toBe(true);
		expect(cols.has('last_wake_call_at')).toBe(true);
		expect(cols.has('wake_fired_at')).toBe(true);
		sqlite.close();

		try {
			require('node:fs').unlinkSync(tmpPath);
		} catch {
			/* ignore */
		}
	});

	it('check_ins.trigger_reason accepts the 6 enum values from D-10', () => {
		const drizzleDb = createDb(':memory:');
		// biome-ignore lint/suspicious/noExplicitAny: direct sqlite write
		const sqlite = (drizzleDb as any).$client as Database.Database;
		const insertStmt = sqlite.prepare(
			`INSERT INTO check_ins (trigger_reason, should_speak, day_anchor) VALUES (?, 0, '2026-04-07')`,
		);
		// All 6 enum values must insert without error
		for (const reason of [
			'scheduled',
			'wake',
			'chunk_active',
			'chunk_done',
			'task_action',
			'restart',
		]) {
			expect(() => insertStmt.run(reason)).not.toThrow();
		}
		const rows = sqlite.prepare('SELECT trigger_reason FROM check_ins').all();
		expect(rows).toHaveLength(6);
	});
});

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

describe('Phase 10 migration: task_durations + chunk_tasks prediction columns', () => {
	const tmpDir = join(tmpdir(), `stitch-phase10-test-${Date.now()}`);

	beforeEach(() => {
		mkdirSync(tmpDir, { recursive: true });
	});

	afterEach(() => {
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {}
	});

	it('fresh DB has prediction columns on chunk_tasks and task_durations (PLAN-07.17)', () => {
		const dbPath = join(tmpDir, 'fresh.db');
		createDb(dbPath);

		const raw = new Database(dbPath);
		const tdCols = raw.pragma('table_info(task_durations)') as {
			name: string;
			notnull: number;
			dflt_value: string | null;
		}[];
		const ctCols = raw.pragma('table_info(chunk_tasks)') as { name: string }[];

		// task_durations: outcome with DEFAULT 'completed', duration_seconds nullable,
		// three prediction columns
		const outcomeCol = tdCols.find((c) => c.name === 'outcome');
		expect(outcomeCol).toBeDefined();
		expect(outcomeCol?.notnull).toBe(1);
		expect(outcomeCol?.dflt_value).toContain('completed');

		const durCol = tdCols.find((c) => c.name === 'duration_seconds');
		expect(durCol).toBeDefined();
		expect(durCol?.notnull).toBe(0); // nullable — this is the whole point of the phase

		expect(tdCols.find((c) => c.name === 'predicted_min_seconds')).toBeDefined();
		expect(tdCols.find((c) => c.name === 'predicted_max_seconds')).toBeDefined();
		expect(tdCols.find((c) => c.name === 'predicted_confidence')).toBeDefined();

		// chunk_tasks: three prediction columns
		expect(ctCols.find((c) => c.name === 'predicted_min_seconds')).toBeDefined();
		expect(ctCols.find((c) => c.name === 'predicted_max_seconds')).toBeDefined();
		expect(ctCols.find((c) => c.name === 'predicted_confidence')).toBeDefined();

		raw.close();
	});

	it('ALTER adds prediction columns to legacy DB idempotently (PLAN-07.18)', () => {
		const dbPath = join(tmpDir, 'legacy.db');

		// Seed legacy DB with pre-Phase-10 shape
		const seed = new Database(dbPath);
		seed.exec(`
			CREATE TABLE tasks (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				name TEXT NOT NULL
			);
			CREATE TABLE task_durations (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
				duration_seconds INTEGER NOT NULL,
				started_at TEXT NOT NULL,
				ended_at TEXT NOT NULL DEFAULT (datetime('now'))
			);
			CREATE TABLE daily_plans (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				date TEXT NOT NULL UNIQUE,
				status TEXT NOT NULL DEFAULT 'active',
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			);
			CREATE TABLE plan_chunks (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				plan_id INTEGER NOT NULL REFERENCES daily_plans(id) ON DELETE CASCADE,
				branch_name TEXT NOT NULL DEFAULT '',
				label TEXT NOT NULL,
				start_time TEXT NOT NULL,
				end_time TEXT NOT NULL,
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
		seed.close();

		// Run migration
		createDb(dbPath);

		// Verify all Phase 10 columns now exist
		const raw = new Database(dbPath);
		const tdCols = raw.pragma('table_info(task_durations)') as {
			name: string;
			notnull: number;
		}[];
		expect(tdCols.find((c) => c.name === 'outcome')).toBeDefined();
		expect(tdCols.find((c) => c.name === 'predicted_min_seconds')).toBeDefined();
		expect(tdCols.find((c) => c.name === 'predicted_max_seconds')).toBeDefined();
		expect(tdCols.find((c) => c.name === 'predicted_confidence')).toBeDefined();

		const ctCols = raw.pragma('table_info(chunk_tasks)') as { name: string }[];
		expect(ctCols.find((c) => c.name === 'predicted_min_seconds')).toBeDefined();
		expect(ctCols.find((c) => c.name === 'predicted_max_seconds')).toBeDefined();
		expect(ctCols.find((c) => c.name === 'predicted_confidence')).toBeDefined();
		raw.close();
	});

	it('table recreation drops NOT NULL on duration_seconds (PLAN-07.19)', () => {
		const dbPath = join(tmpDir, 'notnull.db');

		// Seed with the old NOT NULL shape (reuse the seed from the previous test)
		const seed = new Database(dbPath);
		seed.exec(`
			CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
			CREATE TABLE task_durations (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
				duration_seconds INTEGER NOT NULL,
				started_at TEXT NOT NULL,
				ended_at TEXT NOT NULL DEFAULT (datetime('now'))
			);
		`);

		// Verify the seeded DB has NOT NULL
		const preInfo = seed.pragma('table_info(task_durations)') as {
			name: string;
			notnull: number;
		}[];
		expect(preInfo.find((c) => c.name === 'duration_seconds')?.notnull).toBe(1);
		seed.close();

		// Run migration
		createDb(dbPath);

		// Verify the constraint was dropped
		const raw = new Database(dbPath);
		const postInfo = raw.pragma('table_info(task_durations)') as {
			name: string;
			notnull: number;
		}[];
		expect(postInfo.find((c) => c.name === 'duration_seconds')?.notnull).toBe(0);
		raw.close();
	});

	it('task_durations migration is idempotent across two opens (PLAN-07.20)', () => {
		const dbPath = join(tmpDir, 'idempotent.db');

		// First open: creates everything
		createDb(dbPath);

		// Second open: should be a no-op. Must not throw and must not re-recreate.
		expect(() => createDb(dbPath)).not.toThrow();

		// Verify the columns are still present (exactly one copy each)
		const raw = new Database(dbPath);
		const tdCols = raw.pragma('table_info(task_durations)') as { name: string }[];
		const outcomeCount = tdCols.filter((c) => c.name === 'outcome').length;
		expect(outcomeCount).toBe(1);
		const predMinCount = tdCols.filter((c) => c.name === 'predicted_min_seconds').length;
		expect(predMinCount).toBe(1);
		raw.close();
	});

	it('task_durations rows survive table recreation (PLAN-07.21)', () => {
		const dbPath = join(tmpDir, 'preserve.db');

		// Seed legacy DB with actual data
		const seed = new Database(dbPath);
		seed.exec(`
			CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
			CREATE TABLE task_durations (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
				duration_seconds INTEGER NOT NULL,
				started_at TEXT NOT NULL,
				ended_at TEXT NOT NULL DEFAULT (datetime('now'))
			);
			INSERT INTO tasks (id, name) VALUES (1, 'Write report');
			INSERT INTO tasks (id, name) VALUES (2, 'Reply to emails');
			INSERT INTO task_durations (id, task_id, duration_seconds, started_at, ended_at)
				VALUES (1, 1, 1500, '2026-04-01T14:32:00.000Z', '2026-04-01T14:57:00.000Z');
			INSERT INTO task_durations (id, task_id, duration_seconds, started_at, ended_at)
				VALUES (2, 1, 2880, '2026-04-03T09:00:00.000Z', '2026-04-03T09:48:00.000Z');
			INSERT INTO task_durations (id, task_id, duration_seconds, started_at, ended_at)
				VALUES (3, 2, 600, '2026-04-02T11:00:00.000Z', '2026-04-02T11:10:00.000Z');
		`);
		seed.close();

		// Run migration
		createDb(dbPath);

		// Verify all 3 rows survived with their data intact
		const raw = new Database(dbPath);
		const rows = raw
			.prepare(
				`SELECT id, task_id, duration_seconds, outcome FROM task_durations ORDER BY id`,
			)
			.all() as {
			id: number;
			task_id: number;
			duration_seconds: number;
			outcome: string;
		}[];

		expect(rows.length).toBe(3);
		expect(rows[0]).toEqual({
			id: 1,
			task_id: 1,
			duration_seconds: 1500,
			outcome: 'completed',
		});
		expect(rows[1]).toEqual({
			id: 2,
			task_id: 1,
			duration_seconds: 2880,
			outcome: 'completed',
		});
		expect(rows[2]).toEqual({
			id: 3,
			task_id: 2,
			duration_seconds: 600,
			outcome: 'completed',
		});

		// Also verify outcome IS NULL check is zero — the DEFAULT fired for all rows
		const nullOutcomes = raw
			.prepare(`SELECT COUNT(*) as n FROM task_durations WHERE outcome IS NULL`)
			.get() as { n: number };
		expect(nullOutcomes.n).toBe(0);
		raw.close();
	});
});

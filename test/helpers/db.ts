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
		CREATE TABLE IF NOT EXISTS blueprints (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT NOT NULL,
			is_active INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE TABLE IF NOT EXISTS blueprint_cycles (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			blueprint_id INTEGER NOT NULL REFERENCES blueprints(id) ON DELETE CASCADE,
			name TEXT NOT NULL,
			sort_order INTEGER NOT NULL DEFAULT 0,
			start_time TEXT NOT NULL,
			end_time TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS blueprint_time_blocks (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			cycle_id INTEGER NOT NULL REFERENCES blueprint_cycles(id) ON DELETE CASCADE,
			label TEXT,
			start_time TEXT NOT NULL,
			end_time TEXT NOT NULL,
			is_slot INTEGER NOT NULL DEFAULT 1,
			sort_order INTEGER NOT NULL DEFAULT 0
		);
		CREATE TABLE IF NOT EXISTS day_trees (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			tree TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE TABLE IF NOT EXISTS daily_plans (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			date TEXT NOT NULL UNIQUE,
			blueprint_id INTEGER REFERENCES blueprints(id),
			day_tree_id INTEGER REFERENCES day_trees(id),
			status TEXT NOT NULL DEFAULT 'active',
			llm_reasoning TEXT,
			started_at TEXT,
			last_wake_call_at TEXT,
			wake_fired_at TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE TABLE IF NOT EXISTS plan_chunks (
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
		CREATE TABLE IF NOT EXISTS chunk_tasks (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			chunk_id INTEGER NOT NULL REFERENCES plan_chunks(id) ON DELETE CASCADE,
			task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
			label TEXT NOT NULL,
			is_locked INTEGER NOT NULL DEFAULT 0,
			sort_order INTEGER NOT NULL DEFAULT 0,
			status TEXT NOT NULL DEFAULT 'pending'
		);
		CREATE TABLE IF NOT EXISTS pending_cleanups (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			chat_id INTEGER NOT NULL,
			user_msg_id INTEGER NOT NULL,
			reply_msg_id INTEGER,
			delete_after TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS check_ins (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			trigger_reason TEXT NOT NULL,
			should_speak INTEGER NOT NULL,
			message_text TEXT,
			next_check_minutes INTEGER,
			day_anchor TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_check_ins_day_anchor ON check_ins(day_anchor);
	`);
	return drizzle(sqlite, { schema });
}

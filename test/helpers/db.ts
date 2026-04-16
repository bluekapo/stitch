import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { StitchDb } from '../../src/db/index.js';
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
			duration_seconds INTEGER,
			outcome TEXT NOT NULL DEFAULT 'completed',
			predicted_min_seconds INTEGER,
			predicted_max_seconds INTEGER,
			predicted_confidence TEXT,
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
			status TEXT NOT NULL DEFAULT 'pending',
			predicted_min_seconds INTEGER,
			predicted_max_seconds INTEGER,
			predicted_confidence TEXT
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

		-- Phase 13: sessions, conversations, settings tables
		CREATE TABLE IF NOT EXISTS sessions (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			started_at TEXT NOT NULL DEFAULT (datetime('now')),
			ended_at TEXT
		);
		CREATE TABLE IF NOT EXISTS conversations (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
			content TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			classifier_intent TEXT,
			triggered_by TEXT CHECK (
				triggered_by IS NULL
				OR triggered_by IN ('first_ever', 'back_online', 'tree_missing', 'tree_setup_reply', 'tree_confirm_reply')
			),
			session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE
		);
		CREATE INDEX IF NOT EXISTS idx_conversations_created_at ON conversations(created_at DESC);
		CREATE INDEX IF NOT EXISTS idx_conversations_session_id ON conversations(session_id);
		CREATE TABLE IF NOT EXISTS settings (
			id INTEGER PRIMARY KEY,
			first_boot_shown INTEGER NOT NULL DEFAULT 0
		);
		INSERT OR IGNORE INTO settings (id, first_boot_shown) VALUES (1, 0);
	`);
	return drizzle(sqlite, { schema });
}

// ---------------------------------------------------------------------------
// Phase 13 Wave 0: Seed helpers for new tables (sessions, conversations, settings).
//
// These helpers target schema exports that do NOT exist yet (Wave 1 Plan 02
// adds them to src/db/schema.ts). Importing them here is intentional —
// the import failure is the expected RED state that confirms the contract.
// ---------------------------------------------------------------------------

// NOTE: These imports will fail until Wave 1 adds sessions/conversations/settings
// to src/db/schema.ts. That is the expected Nyquist RED state.
// Uncomment when the schema exports land:
// import { sessions, conversations, settings } from '../../src/db/schema.js';

/**
 * Seed a sessions row. Returns the new row's id.
 *
 * Uses raw SQL because the Drizzle schema export does not exist yet (Wave 1).
 * Once `sessions` is exported from schema.ts, this can be rewritten to use
 * `db.insert(sessions)`.
 */
export function seedSession(
	db: StitchDb,
	opts: { startedAt: string; endedAt?: string | null },
): number {
	const result = db.$client
		.prepare('INSERT INTO sessions (started_at, ended_at) VALUES (?, ?) RETURNING id')
		.get(opts.startedAt, opts.endedAt ?? null) as { id: number };
	return result.id;
}

/**
 * Seed conversations rows. Returns ids in insertion order.
 *
 * Uses raw SQL because the Drizzle schema export does not exist yet (Wave 1).
 */
export function seedConversations(
	db: StitchDb,
	rows: Array<{
		role: 'user' | 'assistant';
		content: string;
		sessionId: number;
		classifierIntent?: string | null;
		triggeredBy?: string | null;
		createdAt?: string;
	}>,
): number[] {
	const ids: number[] = [];
	const stmt = db.$client.prepare(
		`INSERT INTO conversations (role, content, session_id, classifier_intent, triggered_by, created_at)
		 VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
		 RETURNING id`,
	);
	for (const row of rows) {
		const result = stmt.get(
			row.role,
			row.content,
			row.sessionId,
			row.classifierIntent ?? null,
			row.triggeredBy ?? null,
			row.createdAt ?? null,
		) as { id: number };
		ids.push(result.id);
	}
	return ids;
}

/**
 * Seed or upsert the settings singleton row (id=1).
 *
 * Uses raw SQL because the Drizzle schema export does not exist yet (Wave 1).
 */
export function seedSettings(db: StitchDb, opts: { firstBootShown: boolean }): void {
	db.$client
		.prepare('INSERT OR REPLACE INTO settings (id, first_boot_shown) VALUES (1, ?)')
		.run(opts.firstBootShown ? 1 : 0);
}

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

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

export type StitchDb = ReturnType<typeof createDb>;

export function createDb(dbPath: string) {
	const sqlite = new Database(dbPath);
	sqlite.pragma('journal_mode = WAL');
	return drizzle(sqlite, { schema });
}

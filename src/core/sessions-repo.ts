/**
 * Phase 13 -- sessions lifecycle repo.
 *
 * Pure functions over the `sessions` table. Used by:
 *   - buildApp onReady (Plan 04) to resolve "was there a prior session?" + startSession
 *   - StartupGreetingService (Plan 04) to compute the gap bucket
 *   - buildApp onClose (Plan 04) to endSession
 *   - buildApp onReady (Plan 04) to cleanupOrphanedSessions at boot
 *
 * Sync-only (better-sqlite3). NO LLM calls, NO awaits. Safe inside
 * db.transaction() if callers need it (none currently do).
 */
import { desc, isNull, sql } from 'drizzle-orm';
import type { StitchDb } from '../db/index.js';
import { sessions } from '../db/schema.js';

/** 5 minutes -- absorbs dev reloads, kernel hiccups, node --watch restarts. */
export const SESSION_GRACE_WINDOW_SECONDS = 300;

/** 24 h -- rows older than this with ended_at NULL are treated as crashed. */
export const SESSION_CLEANUP_MAX_AGE_SECONDS = 86400;

/**
 * Most-recent session end timestamp, or null when:
 *   - no rows exist at all, OR
 *   - (now - best available timestamp) < SESSION_GRACE_WINDOW_SECONDS
 *
 * Logic:
 *   1. Prefer the most-recent CLEAN close (ended_at IS NOT NULL).
 *      Return it directly (no grace check -- clean closes are authoritative).
 *   2. If no clean close exists, look for a crashed session (ended_at IS NULL,
 *      started_at older than grace window). Return started_at as best estimate.
 *   3. If all sessions are within grace window, return null (treat as same session).
 *
 * The grace window keeps the greeter from saying "back online after 12
 * seconds" on rapid dev reloads (RESEARCH S4).
 */
export function resolveLastSessionEndAt(db: StitchDb, now: Date): Date | null {
	// 1. Prefer the most recent clean close
	const clean = db
		.select({ endedAt: sessions.endedAt })
		.from(sessions)
		.where(sql`${sessions.endedAt} IS NOT NULL`)
		.orderBy(desc(sessions.endedAt))
		.limit(1)
		.get();

	if (clean?.endedAt) {
		return new Date(clean.endedAt);
	}

	// 2. No clean close -- look for crashed session (ended_at IS NULL)
	const crashed = db
		.select({ startedAt: sessions.startedAt })
		.from(sessions)
		.where(isNull(sessions.endedAt))
		.orderBy(desc(sessions.startedAt))
		.limit(1)
		.get();

	if (crashed) {
		const startedAt = new Date(crashed.startedAt);
		const gapSeconds = Math.floor((now.getTime() - startedAt.getTime()) / 1000);
		if (gapSeconds >= SESSION_GRACE_WINDOW_SECONDS) {
			return startedAt;
		}
	}

	// 3. First boot or within grace window
	return null;
}

/** Insert a fresh sessions row; return its id. */
export function startSession(db: StitchDb, now: Date): number {
	const result = db
		.insert(sessions)
		.values({ startedAt: now.toISOString() })
		.returning({ id: sessions.id })
		.get();
	return result.id;
}

/** Set ended_at = now. Idempotent: second call is a no-op (ended_at already set). */
export function endSession(db: StitchDb, sessionId: number, now: Date): void {
	db.update(sessions)
		.set({ endedAt: now.toISOString() })
		.where(sql`${sessions.id} = ${sessionId} AND ${sessions.endedAt} IS NULL`)
		.run();
}

/**
 * Crash-without-close defender. Rewrites ended_at = started_at for rows
 * that have been "open" longer than the grace window. Called once at boot
 * BEFORE startSession, so we never accidentally close a session we just opened.
 */
export function cleanupOrphanedSessions(db: StitchDb, now: Date): void {
	const cutoff = new Date(now.getTime() - SESSION_GRACE_WINDOW_SECONDS * 1000);
	db.update(sessions)
		.set({ endedAt: sql`${sessions.startedAt}` })
		.where(sql`${sessions.endedAt} IS NULL AND ${sessions.startedAt} < ${cutoff.toISOString()}`)
		.run();
}

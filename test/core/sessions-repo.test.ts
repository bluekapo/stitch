import { describe, expect, it } from 'vitest';
import {
	cleanupOrphanedSessions,
	resolveLastSessionEndAt,
	startSession,
} from '../../src/core/sessions-repo.js';
import { createTestDb, seedSession } from '../helpers/db.js';

/**
 * Phase 13 Wave 0: RED unit tests for sessions-repo.
 *
 * These tests INTENTIONALLY fail today because src/core/sessions-repo.ts
 * does not exist yet. Wave 1 (Plan 02) creates it and turns these green.
 *
 * Covers resolveLastSessionEndAt (4 branches), startSession, and
 * cleanupOrphanedSessions with the 5-minute grace window.
 */

const GRACE_MS = 5 * 60 * 1000; // 300_000ms = 5 minutes

describe('sessions-repo', () => {
	describe('resolveLastSessionEndAt', () => {
		it('returns most-recent ended_at when any clean-close session exists', () => {
			const db = createTestDb();
			seedSession(db, {
				startedAt: '2026-04-15T08:00:00Z',
				endedAt: '2026-04-15T12:00:00Z',
			});
			seedSession(db, {
				startedAt: '2026-04-15T14:00:00Z',
				endedAt: '2026-04-15T18:00:00Z',
			});

			const now = new Date('2026-04-16T12:00:00Z');
			const result = resolveLastSessionEndAt(db, now);
			expect(result).toEqual(new Date('2026-04-15T18:00:00Z'));
		});

		it('returns started_at of crashed row when ended_at IS NULL and started_at > 5min ago', () => {
			const db = createTestDb();
			// Crashed session started 2 hours ago (well past grace window)
			seedSession(db, {
				startedAt: '2026-04-16T10:00:00Z',
				endedAt: null,
			});

			const now = new Date('2026-04-16T12:00:00Z');
			const result = resolveLastSessionEndAt(db, now);
			// Should fallback to started_at of the crashed row
			expect(result).toEqual(new Date('2026-04-16T10:00:00Z'));
		});

		it('returns null when only stale-within-grace crashed row exists', () => {
			const db = createTestDb();
			// Crashed session started 2 minutes ago (within 5min grace window)
			seedSession(db, {
				startedAt: '2026-04-16T11:58:00Z',
				endedAt: null,
			});

			const now = new Date('2026-04-16T12:00:00Z');
			const result = resolveLastSessionEndAt(db, now);
			// Within grace = might still be running, treat as no prior session
			expect(result).toBeNull();
		});

		it('returns null when sessions table is empty', () => {
			const db = createTestDb();
			const now = new Date('2026-04-16T12:00:00Z');
			const result = resolveLastSessionEndAt(db, now);
			expect(result).toBeNull();
		});
	});

	describe('startSession', () => {
		it('inserts a session row and returns the new id', () => {
			const db = createTestDb();
			const now = new Date('2026-04-16T12:00:00Z');
			const id = startSession(db, now);
			expect(typeof id).toBe('number');
			expect(id).toBeGreaterThan(0);

			// Verify the row exists
			const row = db.$client.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as {
				started_at: string;
				ended_at: string | null;
			};
			expect(row.started_at).toBeTruthy();
			expect(row.ended_at).toBeNull();
		});
	});

	describe('cleanupOrphanedSessions', () => {
		it('marks rows with null ended_at older than 5min by writing ended_at = started_at', () => {
			const db = createTestDb();
			// Orphaned session started 10 minutes ago
			const orphanId = seedSession(db, {
				startedAt: '2026-04-16T11:50:00Z',
				endedAt: null,
			});
			// Recent session started 2 minutes ago (within grace, should NOT be cleaned)
			const recentId = seedSession(db, {
				startedAt: '2026-04-16T11:58:00Z',
				endedAt: null,
			});

			const now = new Date('2026-04-16T12:00:00Z');
			cleanupOrphanedSessions(db, now);

			// Orphaned session should have ended_at = started_at
			const orphan = db.$client.prepare('SELECT * FROM sessions WHERE id = ?').get(orphanId) as {
				started_at: string;
				ended_at: string | null;
			};
			expect(orphan.ended_at).toBe(orphan.started_at);

			// Recent session should still have ended_at = null (within grace window)
			const recent = db.$client.prepare('SELECT * FROM sessions WHERE id = ?').get(recentId) as {
				ended_at: string | null;
			};
			expect(recent.ended_at).toBeNull();
		});
	});
});

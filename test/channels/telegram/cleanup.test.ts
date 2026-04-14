import type { Api } from 'grammy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	CLEANUP_DELAY_MS,
	flushPendingCleanups,
	scheduleCleanup,
	schedulePerMessageCleanup,
} from '../../../src/channels/telegram/cleanup.js';
import type { StitchContext } from '../../../src/channels/telegram/types.js';
import { pendingCleanups } from '../../../src/db/schema.js';
import { createTestDb } from '../../helpers/db.js';

function createMockCtx() {
	const calls: Array<{ method: string; args: unknown[] }> = [];
	const ctx = {
		api: {
			deleteMessage: vi.fn(async (chatId: number, messageId: number) => {
				calls.push({ method: 'deleteMessage', args: [chatId, messageId] });
				return true;
			}),
		},
	} as unknown as StitchContext;
	return { ctx, calls };
}

describe('scheduleCleanup', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('deletes user message and reply after CLEANUP_DELAY_MS', async () => {
		const { ctx, calls } = createMockCtx();
		scheduleCleanup(ctx, 100, 1, 2);

		// No deletions yet
		expect(calls.length).toBe(0);

		await vi.advanceTimersByTimeAsync(CLEANUP_DELAY_MS);

		expect(calls.length).toBe(2);
		expect(calls[0]).toEqual({ method: 'deleteMessage', args: [100, 1] });
		expect(calls[1]).toEqual({ method: 'deleteMessage', args: [100, 2] });
	});

	it('deletes only user message when replyMsgId is undefined', async () => {
		const { ctx, calls } = createMockCtx();
		scheduleCleanup(ctx, 100, 1, undefined);

		await vi.advanceTimersByTimeAsync(CLEANUP_DELAY_MS);

		expect(calls.length).toBe(1);
		expect(calls[0]).toEqual({ method: 'deleteMessage', args: [100, 1] });
	});

	it('does not throw when deleteMessage fails', async () => {
		const { ctx } = createMockCtx();
		(ctx.api.deleteMessage as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('forbidden'));

		scheduleCleanup(ctx, 100, 1, 2);

		// Should not throw
		await vi.advanceTimersByTimeAsync(CLEANUP_DELAY_MS);
	});

	it('exports CLEANUP_DELAY_MS as 60000', () => {
		expect(CLEANUP_DELAY_MS).toBe(60_000);
	});

	it('persists pending cleanup to DB when db is provided', async () => {
		const db = createTestDb();
		const { ctx } = createMockCtx();

		scheduleCleanup(ctx, 100, 1, 2, db);

		// Row should exist in pending_cleanups
		const rows = db.select().from(pendingCleanups).all();
		expect(rows.length).toBe(1);
		expect(rows[0].chatId).toBe(100);
		expect(rows[0].userMsgId).toBe(1);
		expect(rows[0].replyMsgId).toBe(2);
		expect(rows[0].deleteAfter).toBeTruthy();

		// After timer fires, row should be removed
		await vi.advanceTimersByTimeAsync(CLEANUP_DELAY_MS);
		const rowsAfter = db.select().from(pendingCleanups).all();
		expect(rowsAfter.length).toBe(0);
	});

	it('persists with null replyMsgId when reply is undefined', async () => {
		const db = createTestDb();
		const { ctx } = createMockCtx();

		scheduleCleanup(ctx, 100, 1, undefined, db);

		const rows = db.select().from(pendingCleanups).all();
		expect(rows.length).toBe(1);
		expect(rows[0].replyMsgId).toBeNull();

		await vi.advanceTimersByTimeAsync(CLEANUP_DELAY_MS);
	});

	it('still works without db (backward compat)', async () => {
		const { ctx, calls } = createMockCtx();
		scheduleCleanup(ctx, 100, 1, 2);

		await vi.advanceTimersByTimeAsync(CLEANUP_DELAY_MS);
		expect(calls.length).toBe(2);
	});
});

describe('flushPendingCleanups', () => {
	it('deletes messages for rows whose delete_after has passed', async () => {
		const db = createTestDb();
		const deleteMessage = vi.fn().mockResolvedValue(true);

		// Insert a row with a past timestamp
		db.insert(pendingCleanups)
			.values({
				chatId: 100,
				userMsgId: 1,
				replyMsgId: 2,
				deleteAfter: new Date(Date.now() - 10_000).toISOString(),
			})
			.run();

		const flushed = await flushPendingCleanups(db, { deleteMessage });

		expect(flushed).toBe(1);
		expect(deleteMessage).toHaveBeenCalledTimes(2);
		expect(deleteMessage).toHaveBeenCalledWith(100, 1);
		expect(deleteMessage).toHaveBeenCalledWith(100, 2);

		// Row should be removed from DB
		const rows = db.select().from(pendingCleanups).all();
		expect(rows.length).toBe(0);
	});

	it('flushes all rows regardless of delete_after timestamp', async () => {
		const db = createTestDb();
		const deleteMessage = vi.fn().mockResolvedValue(true);

		db.insert(pendingCleanups)
			.values({
				chatId: 100,
				userMsgId: 1,
				replyMsgId: 2,
				deleteAfter: new Date(Date.now() + 60_000).toISOString(),
			})
			.run();

		const flushed = await flushPendingCleanups(db, { deleteMessage });

		expect(flushed).toBe(1);
		expect(deleteMessage).toHaveBeenCalledTimes(2);

		const rows = db.select().from(pendingCleanups).all();
		expect(rows.length).toBe(0);
	});

	it('handles null replyMsgId (only deletes user message)', async () => {
		const db = createTestDb();
		const deleteMessage = vi.fn().mockResolvedValue(true);

		db.insert(pendingCleanups)
			.values({
				chatId: 100,
				userMsgId: 5,
				replyMsgId: null,
				deleteAfter: new Date(Date.now() - 1000).toISOString(),
			})
			.run();

		await flushPendingCleanups(db, { deleteMessage });

		expect(deleteMessage).toHaveBeenCalledTimes(1);
		expect(deleteMessage).toHaveBeenCalledWith(100, 5);
	});

	it('continues processing remaining rows when one deleteMessage fails', async () => {
		const db = createTestDb();
		const deleteMessage = vi
			.fn()
			.mockRejectedValueOnce(new Error('forbidden'))
			.mockResolvedValue(true);

		db.insert(pendingCleanups)
			.values({
				chatId: 100,
				userMsgId: 1,
				replyMsgId: null,
				deleteAfter: new Date(Date.now() - 1000).toISOString(),
			})
			.run();
		db.insert(pendingCleanups)
			.values({
				chatId: 200,
				userMsgId: 3,
				replyMsgId: null,
				deleteAfter: new Date(Date.now() - 1000).toISOString(),
			})
			.run();

		const flushed = await flushPendingCleanups(db, { deleteMessage });

		expect(flushed).toBe(2);
		// Both rows attempted and removed even if Telegram delete failed
		const rows = db.select().from(pendingCleanups).all();
		expect(rows.length).toBe(0);
	});

	it('returns 0 when no pending cleanups exist', async () => {
		const db = createTestDb();
		const deleteMessage = vi.fn();

		const flushed = await flushPendingCleanups(db, { deleteMessage });

		expect(flushed).toBe(0);
		expect(deleteMessage).not.toHaveBeenCalled();
	});
});

describe('schedulePerMessageCleanup -- Phase 9 standalone bot messages', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('persists a pending_cleanups row with replyMsgId=null and ttlMs-based delete_after', () => {
		const db = createTestDb();
		const api = {
			deleteMessage: vi.fn().mockResolvedValue(true),
		} as unknown as Api;
		const ttlMs = 900_000; // 15 min
		const before = Date.now();

		schedulePerMessageCleanup(api, 12345, 67890, db, ttlMs);

		const rows = db.select().from(pendingCleanups).all();
		expect(rows).toHaveLength(1);
		expect(rows[0].chatId).toBe(12345);
		expect(rows[0].userMsgId).toBe(67890);
		expect(rows[0].replyMsgId).toBeNull();

		const deleteAfter = new Date(rows[0].deleteAfter).getTime();
		expect(deleteAfter).toBeGreaterThanOrEqual(before + ttlMs - 100);
		expect(deleteAfter).toBeLessThanOrEqual(before + ttlMs + 1000);
	});

	it('ttlMs flow: setTimeout fires deleteMessage after ttlMs', async () => {
		const db = createTestDb();
		const api = {
			deleteMessage: vi.fn().mockResolvedValue(true),
		} as unknown as Api;

		schedulePerMessageCleanup(api, 100, 200, db, 900_000);

		// Before TTL: deleteMessage not called yet
		expect(api.deleteMessage).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(900_000);

		expect(api.deleteMessage).toHaveBeenCalledWith(100, 200);
	});

	it('ttlMs flow: removes the pending_cleanups row after deletion succeeds', async () => {
		const db = createTestDb();
		const api = {
			deleteMessage: vi.fn().mockResolvedValue(true),
		} as unknown as Api;

		schedulePerMessageCleanup(api, 100, 200, db, 900_000);
		expect(db.select().from(pendingCleanups).all()).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(900_000);
		// microtask flush
		await Promise.resolve();
		await Promise.resolve();

		expect(db.select().from(pendingCleanups).all()).toHaveLength(0);
	});

	it('ttlMs differs from CLEANUP_DELAY_MS — verifies the helper is NOT hard-coded to 60s', async () => {
		const db = createTestDb();
		const api = {
			deleteMessage: vi.fn().mockResolvedValue(true),
		} as unknown as Api;

		schedulePerMessageCleanup(api, 100, 200, db, 900_000);

		// Advance past the 60s default — must NOT have fired yet
		await vi.advanceTimersByTimeAsync(60_000);
		expect(api.deleteMessage).not.toHaveBeenCalled();

		// Advance the rest of the way to 15 min — must fire
		await vi.advanceTimersByTimeAsync(900_000 - 60_000);
		expect(api.deleteMessage).toHaveBeenCalledWith(100, 200);
	});
});

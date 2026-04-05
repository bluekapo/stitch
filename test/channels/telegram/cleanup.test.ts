import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scheduleCleanup, flushPendingCleanups, CLEANUP_DELAY_MS } from '../../../src/channels/telegram/cleanup.js';
import { pendingCleanups } from '../../../src/db/schema.js';
import type { StitchContext } from '../../../src/channels/telegram/types.js';
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
		db.insert(pendingCleanups).values({
			chatId: 100,
			userMsgId: 1,
			replyMsgId: 2,
			deleteAfter: new Date(Date.now() - 10_000).toISOString(),
		}).run();

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

		db.insert(pendingCleanups).values({
			chatId: 100,
			userMsgId: 1,
			replyMsgId: 2,
			deleteAfter: new Date(Date.now() + 60_000).toISOString(),
		}).run();

		const flushed = await flushPendingCleanups(db, { deleteMessage });

		expect(flushed).toBe(1);
		expect(deleteMessage).toHaveBeenCalledTimes(2);

		const rows = db.select().from(pendingCleanups).all();
		expect(rows.length).toBe(0);
	});

	it('handles null replyMsgId (only deletes user message)', async () => {
		const db = createTestDb();
		const deleteMessage = vi.fn().mockResolvedValue(true);

		db.insert(pendingCleanups).values({
			chatId: 100,
			userMsgId: 5,
			replyMsgId: null,
			deleteAfter: new Date(Date.now() - 1000).toISOString(),
		}).run();

		await flushPendingCleanups(db, { deleteMessage });

		expect(deleteMessage).toHaveBeenCalledTimes(1);
		expect(deleteMessage).toHaveBeenCalledWith(100, 5);
	});

	it('continues processing remaining rows when one deleteMessage fails', async () => {
		const db = createTestDb();
		const deleteMessage = vi.fn()
			.mockRejectedValueOnce(new Error('forbidden'))
			.mockResolvedValue(true);

		db.insert(pendingCleanups).values({
			chatId: 100,
			userMsgId: 1,
			replyMsgId: null,
			deleteAfter: new Date(Date.now() - 1000).toISOString(),
		}).run();
		db.insert(pendingCleanups).values({
			chatId: 200,
			userMsgId: 3,
			replyMsgId: null,
			deleteAfter: new Date(Date.now() - 1000).toISOString(),
		}).run();

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

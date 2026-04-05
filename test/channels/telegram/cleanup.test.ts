import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scheduleCleanup, CLEANUP_DELAY_MS } from '../../../src/channels/telegram/cleanup.js';
import type { StitchContext } from '../../../src/channels/telegram/types.js';

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
});

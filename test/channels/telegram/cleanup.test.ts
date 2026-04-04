import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { autoCleanup, CLEANUP_DELAY_MS } from '../../../src/channels/telegram/cleanup.js';
import { createTestBot, fakeTextMessageUpdate } from '../../helpers/telegram.js';

describe('autoCleanup middleware', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('sends "Got it." reply before deletion', async () => {
		const { bot, outgoing } = createTestBot();
		bot.on('message:text', autoCleanup);

		await bot.init();
		await bot.handleUpdate(fakeTextMessageUpdate('hello') as never);

		const sendCalls = outgoing.filter((c) => c.method === 'sendMessage');
		expect(sendCalls.length).toBeGreaterThanOrEqual(1);
		const gotIt = sendCalls.find(
			(c) => (c.payload as Record<string, unknown>).text === 'Got it.',
		);
		expect(gotIt).toBeDefined();
	});

	it('schedules deletion of user message and bot reply after CLEANUP_DELAY_MS', async () => {
		const { bot, outgoing } = createTestBot();
		bot.on('message:text', autoCleanup);

		await bot.init();
		await bot.handleUpdate(fakeTextMessageUpdate('hello') as never);

		// No deletions yet
		const deletesBefore = outgoing.filter((c) => c.method === 'deleteMessage');
		expect(deletesBefore.length).toBe(0);

		// Advance timers
		await vi.advanceTimersByTimeAsync(CLEANUP_DELAY_MS);

		const deletesAfter = outgoing.filter((c) => c.method === 'deleteMessage');
		expect(deletesAfter.length).toBe(2);
	});

	it('exports CLEANUP_DELAY_MS as 3000', () => {
		expect(CLEANUP_DELAY_MS).toBe(3000);
	});
});

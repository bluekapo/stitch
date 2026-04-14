import { describe, expect, it, vi } from 'vitest';
import { safeEditMessageText } from '../../../src/channels/telegram/menus/helpers.js';
import type { StitchContext } from '../../../src/channels/telegram/types.js';

function mkCtx(overrides: Partial<StitchContext> = {}): StitchContext {
	const ctx = {
		editMessageText: vi.fn().mockResolvedValue(undefined),
		answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
		...overrides,
	} as unknown as StitchContext;
	return ctx;
}

describe('safeEditMessageText', () => {
	it('calls editMessageText with parse_mode HTML by default', async () => {
		const ctx = mkCtx();
		await safeEditMessageText(ctx, 'hello');
		expect(ctx.editMessageText).toHaveBeenCalledTimes(1);
		expect(ctx.editMessageText).toHaveBeenCalledWith('hello', { parse_mode: 'HTML' });
	});

	it('forwards explicit opts to editMessageText', async () => {
		const ctx = mkCtx();
		await safeEditMessageText(ctx, 'text', { parse_mode: 'HTML' });
		expect(ctx.editMessageText).toHaveBeenCalledWith('text', { parse_mode: 'HTML' });
	});

	it("swallows 'message is not modified' error and answers the callback query", async () => {
		const ctx = mkCtx({
			editMessageText: vi.fn().mockRejectedValue(new Error('Bad Request: message is not modified')),
			answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
		} as Partial<StitchContext>);

		await expect(safeEditMessageText(ctx, 'unchanged')).resolves.toBeUndefined();
		expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
	});

	it('swallows answerCallbackQuery errors silently on the not-modified path', async () => {
		const ctx = mkCtx({
			editMessageText: vi.fn().mockRejectedValue(new Error('Bad Request: message is not modified')),
			answerCallbackQuery: vi.fn().mockRejectedValue(new Error('answer failed')),
		} as Partial<StitchContext>);

		await expect(safeEditMessageText(ctx, 'unchanged')).resolves.toBeUndefined();
	});

	it('re-throws any error that is not "message is not modified"', async () => {
		const ctx = mkCtx({
			editMessageText: vi.fn().mockRejectedValue(new Error('Network error')),
		} as Partial<StitchContext>);

		await expect(safeEditMessageText(ctx, 'text')).rejects.toThrow('Network error');
	});

	it('re-throws non-Error rejections unchanged', async () => {
		const ctx = mkCtx({
			editMessageText: vi.fn().mockRejectedValue('string-error'),
		} as Partial<StitchContext>);

		await expect(safeEditMessageText(ctx, 'text')).rejects.toBe('string-error');
	});
});

import type { StitchContext } from './types.js';

export const CLEANUP_DELAY_MS = 60_000;

export function scheduleCleanup(
	ctx: StitchContext,
	chatId: number,
	userMsgId: number,
	replyMsgId: number | undefined,
): void {
	setTimeout(async () => {
		try {
			await ctx.api.deleteMessage(chatId, userMsgId);
		} catch {
			// Message may already be deleted
		}
		if (replyMsgId !== undefined) {
			try {
				await ctx.api.deleteMessage(chatId, replyMsgId);
			} catch {
				// Reply may already be deleted
			}
		}
	}, CLEANUP_DELAY_MS);
}

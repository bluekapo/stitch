import type { NextFunction } from 'grammy';
import type { StitchContext } from './types.js';

export const CLEANUP_DELAY_MS = 3000;

export async function autoCleanup(
	ctx: StitchContext,
	next: NextFunction,
): Promise<void> {
	await next();

	if (!ctx.message?.text) return;

	const chatId = ctx.chat?.id;
	const userMsgId = ctx.message.message_id;
	if (!chatId) return;

	// Send acknowledgment
	const reply = await ctx.reply('Got it.');

	// Schedule deletion of both messages
	setTimeout(async () => {
		try {
			await ctx.api.deleteMessage(chatId, userMsgId);
		} catch {
			// Message may already be deleted or too old
		}
		try {
			await ctx.api.deleteMessage(chatId, reply.message_id);
		} catch {
			// Reply may already be deleted
		}
	}, CLEANUP_DELAY_MS);
}

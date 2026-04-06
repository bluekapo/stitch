import type { StitchContext } from '../types.js';

/**
 * Edits the current callback-query message idempotently. Swallows Telegram's
 * "message is not modified" error -- which fires when a refresh produces
 * identical content -- and answers the callback query so the user's tapped
 * button un-spins instead of appearing hung.
 *
 * Every other error is re-thrown. Use this in every menu handler that calls
 * `editMessageText` via a user-initiated refresh or navigation where content
 * might be unchanged from the prior render.
 */
export async function safeEditMessageText(
	ctx: StitchContext,
	text: string,
	opts: { parse_mode?: 'HTML' } = { parse_mode: 'HTML' },
): Promise<void> {
	try {
		await ctx.editMessageText(text, opts);
	} catch (err) {
		if (err instanceof Error && err.message.includes('message is not modified')) {
			try {
				await ctx.answerCallbackQuery();
			} catch {
				/* ignore -- callback answer is best-effort */
			}
			return;
		}
		throw err;
	}
}

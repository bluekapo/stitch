import { eq } from 'drizzle-orm';
import type { StitchDb } from '../../db/index.js';
import { pendingCleanups } from '../../db/schema.js';
import type { StitchContext } from './types.js';

export const CLEANUP_DELAY_MS = 60_000;

/**
 * Schedule message cleanup: persist to DB (survives restart) + in-memory setTimeout (handles normal flow).
 * When the timer fires, messages are deleted from Telegram and the DB row is removed.
 */
export function scheduleCleanup(
	ctx: StitchContext,
	chatId: number,
	userMsgId: number,
	replyMsgId: number | undefined,
	db?: StitchDb,
): void {
	const deleteAfter = new Date(Date.now() + CLEANUP_DELAY_MS).toISOString();

	// Persist to DB so restart can recover
	let rowId: number | undefined;
	if (db) {
		try {
			const result = db.insert(pendingCleanups).values({
				chatId,
				userMsgId,
				replyMsgId: replyMsgId ?? null,
				deleteAfter,
			}).returning({ id: pendingCleanups.id }).get();
			rowId = result.id;
		} catch {
			// DB write failure should not block cleanup scheduling
		}
	}

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
		// Remove DB row after successful cleanup
		if (db && rowId !== undefined) {
			try {
				db.delete(pendingCleanups).where(eq(pendingCleanups.id, rowId)).run();
			} catch {
				// Best-effort removal
			}
		}
	}, CLEANUP_DELAY_MS);
}

/**
 * On startup, process ALL pending cleanups from previous runs.
 * Any row still in the table means the timer never fired, so delete now.
 */
export async function flushPendingCleanups(
	db: StitchDb,
	botApi: { deleteMessage: (chatId: number, messageId: number) => Promise<unknown> },
): Promise<number> {
	const rows = db.select().from(pendingCleanups).all();

	for (const row of rows) {
		try {
			await botApi.deleteMessage(row.chatId, row.userMsgId);
		} catch {
			// Message may already be deleted or chat inaccessible
		}
		if (row.replyMsgId !== null) {
			try {
				await botApi.deleteMessage(row.chatId, row.replyMsgId);
			} catch {
				// Reply may already be deleted
			}
		}
		try {
			db.delete(pendingCleanups).where(eq(pendingCleanups.id, row.id)).run();
		} catch {
			// Best-effort removal
		}
	}

	return rows.length;
}

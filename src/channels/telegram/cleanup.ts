import { and, eq } from 'drizzle-orm';
import type { Api } from 'grammy';
import type { Logger } from 'pino';
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
 * Phase 9 — Per-message cleanup with custom TTL for standalone bot messages.
 *
 * Use this when you call `bot.api.sendMessage(...)` directly (e.g., from
 * CheckInService) and want the message to auto-delete after a custom TTL
 * (D-11: 15 min for check-ins, vs the 60s default for user-reply pairs).
 *
 * Persists a pending_cleanups row with replyMsgId=null and userMsgId=msgId,
 * so flushPendingCleanups picks it up on restart per the existing pattern.
 *
 * Per D-12: this only touches the pending_cleanups table for Telegram message
 * scheduling. The check_ins table is owned by CheckInService and is NOT
 * affected by this helper or by flushPendingCleanups.
 */
export function schedulePerMessageCleanup(
	api: Api,
	chatId: number,
	msgId: number,
	db: StitchDb,
	ttlMs: number,
	logger?: Logger,
): void {
	const deleteAfter = new Date(Date.now() + ttlMs).toISOString();

	// Persist row (mirrors scheduleCleanup persistence so flushPendingCleanups
	// can pick it up on restart). userMsgId = msgId, replyMsgId = null.
	let rowId: number | undefined;
	try {
		const result = db
			.insert(pendingCleanups)
			.values({
				chatId,
				userMsgId: msgId,
				replyMsgId: null,
				deleteAfter,
			})
			.returning({ id: pendingCleanups.id })
			.get();
		rowId = result.id;
	} catch {
		// DB write failure should not block cleanup scheduling
	}

	setTimeout(async () => {
		try {
			await api.deleteMessage(chatId, msgId);
		} catch (err) {
			logger?.warn?.(
				{ err, chatId, msgId },
				'schedulePerMessageCleanup: deleteMessage failed',
			);
		}
		// Remove the row after deletion attempt (matches scheduleCleanup pattern).
		// Prefer rowId match; fall back to (chatId, msgId) compound match if rowId
		// was lost to a DB write failure above.
		if (rowId !== undefined) {
			try {
				db.delete(pendingCleanups).where(eq(pendingCleanups.id, rowId)).run();
			} catch {
				// Best-effort removal
			}
		} else {
			try {
				db.delete(pendingCleanups)
					.where(
						and(
							eq(pendingCleanups.chatId, chatId),
							eq(pendingCleanups.userMsgId, msgId),
						),
					)
					.run();
			} catch {
				// Best-effort removal
			}
		}
	}, ttlMs);
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

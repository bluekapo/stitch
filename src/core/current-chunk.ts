import type { ChunkTask, PlanChunk } from '../types/daily-plan.js';

/**
 * A plan chunk with its associated tasks. The resolver itself never touches
 * `.tasks`, but the broader code path -- menu view-builders, render functions --
 * expects them to ride along, so the type composition lives here next to the
 * resolver that consumes it.
 */
export type PlanChunkWithTasks = PlanChunk & { tasks: ChunkTask[] };

/**
 * Returns the chunk whose `[startTime, endTime)` interval contains `now`
 * in LOCAL time, or null if no chunk matches.
 *
 * Semantics (D-01, D-03, D-19 from 08.3 decisions):
 * - Half-open interval: startTime is inclusive, endTime is exclusive. A chunk
 *   `10:00-12:00` matches `10:00` and `11:59` but NOT `12:00`.
 * - Local wall-clock time via `Date.getHours()`/`getMinutes()`. Do NOT use the
 *   UTC variants -- `formatTime` in views.ts uses UTC and is a latent bug for
 *   comparison purposes (it's fine for display).
 * - If multiple chunks overlap the same instant (should not happen in practice,
 *   but defensive), the one with the lowest `sortOrder` wins.
 */
export function getCurrentChunk(
	chunks: PlanChunkWithTasks[],
	now: Date,
): PlanChunkWithTasks | null {
	const hhmm = toHhmm(now);
	const matches = chunks
		.filter((c) => hhmm >= c.startTime && hhmm < c.endTime)
		.sort((a, b) => a.sortOrder - b.sortOrder);
	return matches[0] ?? null;
}

/**
 * Returns the HH:MM startTime of the next chunk that starts strictly after
 * `now` in local time, or null when no later chunk exists for the day.
 * Used to render the "No active chunk. Next chunk starts at HH:MM" empty state.
 */
export function getNextChunkStartTime(chunks: PlanChunkWithTasks[], now: Date): string | null {
	const hhmm = toHhmm(now);
	const upcoming = chunks
		.filter((c) => c.startTime > hhmm)
		.sort((a, b) => a.startTime.localeCompare(b.startTime));
	return upcoming[0]?.startTime ?? null;
}

/** Local-time HH:MM string from a Date. Do not replace with UTC helpers. */
function toHhmm(d: Date): string {
	return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

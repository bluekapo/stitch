import type { ChunkTask, PlanChunk } from '../types/daily-plan.js';
import type { DailyPlanService } from './daily-plan-service.js';

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

/**
 * Phase 08.3 D-16 fallback: resolve the current-chunk attachment for a newly
 * created task. If a current chunk is active right now, returns its id and
 * branchName; otherwise returns {null, null} (the task lands fully unattached
 * and only appears in the All Tasks drill-down view).
 *
 * Used by:
 *   - src/channels/telegram/handlers/text-router.ts (add, add!, NL parse)
 *   - src/channels/telegram/handlers/voice-handler.ts (after parse-or-route)
 *
 * No LLM call. The richer "LLM picks the right chunk" path (D-15/D-17) is
 * deferred to Phase 08.4 per RESEARCH §8 recommendation.
 *
 * Defaults `now` to `new Date()` so production callers always re-evaluate
 * the wall clock fresh per call (D-19 invariant).
 */
export function resolveCurrentChunkAttachment(
	dailyPlanService?: DailyPlanService,
	now: Date = new Date(),
): { chunkId: number | null; branchName: string | null } {
	if (!dailyPlanService) return { chunkId: null, branchName: null };
	const plan = dailyPlanService.getTodayPlan();
	if (!plan) return { chunkId: null, branchName: null };
	const { chunks } = dailyPlanService.getPlanWithChunks(plan.id);
	const current = getCurrentChunk(chunks, now);
	if (!current) return { chunkId: null, branchName: null };
	return { chunkId: current.id, branchName: current.branchName };
}

import { getCurrentChunk, getNextChunkStartTime } from '../../core/current-chunk.js';
import type { DailyPlanService } from '../../core/daily-plan-service.js';
import type { TaskService } from '../../core/task-service.js';
import type {
	CurrentChunkTasksView,
	CurrentChunkView,
	DailyPlanView,
} from '../../types/daily-plan.js';

// Phase 10 Plan 05 Task 2: compute chunk rollup values (D-16).
//
// Parses HH:MM timestamps from the chunk shape (same-day assumption — 24h
// rollover is out of scope for Phase 10). Sums predictedMaxSeconds across
// non-null tasks. Returns predictedSumMinutes=null ONLY when EVERY task
// has a null predictedMaxSeconds (D-06 full fall-through).
function computeChunkRollup(
	startTime: string,
	endTime: string,
	tasks: Array<{ predictedMaxSeconds: number | null }>,
): { slotDurationMinutes: number; predictedSumMinutes: number | null } {
	const [sh, sm] = startTime.split(':').map(Number);
	const [eh, em] = endTime.split(':').map(Number);
	const slotDurationMinutes = Math.max(0, eh * 60 + em - (sh * 60 + sm));

	const anyPredicted = tasks.some((t) => t.predictedMaxSeconds != null);
	if (!anyPredicted) {
		return { slotDurationMinutes, predictedSumMinutes: null };
	}

	const totalSeconds = tasks.reduce(
		(acc, t) => acc + (t.predictedMaxSeconds ?? 0),
		0,
	);
	return {
		slotDurationMinutes,
		predictedSumMinutes: Math.round(totalSeconds / 60),
	};
}

/**
 * Phase 08.3 view-builder bridge: shape DailyPlanService outputs into the pure
 * `CurrentChunkView` consumed by `renderCurrentChunkView` (Screen 1).
 *
 * Pure helper -- no DB access of its own, only orchestrates services + the
 * pure `getCurrentChunk` resolver. The optional `now` parameter MUST default
 * to `new Date()` so every call re-evaluates wall-clock time fresh (D-19
 * invariant: refresh at 11:59 vs 12:01 yields different results).
 *
 * Returns `undefined` (Screen 1 Case D fallback) when:
 *   - No DailyPlanService injected
 *   - No plan exists for today
 *
 * Returns a `CurrentChunkView` with chunk=null when a plan exists but no
 * chunk currently contains `now` (Screen 1 Cases B and C).
 */
export function buildCurrentChunkView(
	dailyPlanService?: DailyPlanService,
	now: Date = new Date(),
): CurrentChunkView | undefined {
	if (!dailyPlanService) return undefined;
	const plan = dailyPlanService.getTodayPlan();
	if (!plan) return undefined;

	const { chunks } = dailyPlanService.getPlanWithChunks(plan.id);
	const current = getCurrentChunk(chunks, now);
	const next = current ? null : getNextChunkStartTime(chunks, now);

	if (!current) {
		return {
			date: plan.date,
			branchName: null,
			chunk: null,
			nextChunkStartTime: next,
		};
	}

	const mappedTasks = current.tasks.map((t) => ({
		label: t.label,
		status: t.status,
		isLocked: t.isLocked,
		// Phase 10 (D-15): propagate prediction fields for per-task suffix.
		predictedMaxSeconds: t.predictedMaxSeconds ?? null,
		predictedConfidence: t.predictedConfidence ?? null,
	}));
	const rollup = computeChunkRollup(current.startTime, current.endTime, mappedTasks);

	return {
		date: plan.date,
		branchName: current.branchName ?? null,
		chunk: {
			label: current.label,
			startTime: current.startTime,
			endTime: current.endTime,
			tasks: mappedTasks,
			slotDurationMinutes: rollup.slotDurationMinutes,
			predictedSumMinutes: rollup.predictedSumMinutes,
		},
		nextChunkStartTime: next,
	};
}

/**
 * Phase 08.3 view-builder bridge: shape DailyPlanService + TaskService outputs
 * into the pure `CurrentChunkTasksView` consumed by `renderCurrentChunkTasksView`
 * (Screen 3).
 *
 * Tasks are pulled via `taskService.listForChunk(currentChunk.id)` -- the new
 * scoped query introduced in this plan. They are NOT pulled from `chunk.tasks`
 * (which holds `ChunkTask` rows from chunk_tasks join, used for plan rendering)
 * because the Tasks view needs the live task state (`TaskListItem` shape with
 * `timerStartedAt`, `isEssential`) for the per-task buttons in Wave 3.
 *
 * Same `now` injectability as `buildCurrentChunkView` for D-19 testability.
 */
export function buildCurrentChunkTasksView(
	taskService: TaskService,
	dailyPlanService?: DailyPlanService,
	now: Date = new Date(),
): CurrentChunkTasksView | undefined {
	if (!dailyPlanService) return undefined;
	const plan = dailyPlanService.getTodayPlan();
	if (!plan) return undefined;

	const { chunks } = dailyPlanService.getPlanWithChunks(plan.id);
	const current = getCurrentChunk(chunks, now);
	const next = current ? null : getNextChunkStartTime(chunks, now);

	return {
		chunk: current
			? {
					label: current.label,
					startTime: current.startTime,
					endTime: current.endTime,
					tasks: taskService.listForChunk(current.id),
				}
			: null,
		nextChunkStartTime: next,
	};
}

/**
 * Phase 08.3 view-builder bridge: shape DailyPlanService output into the
 * `DailyPlanView` consumed by `renderDayPlanView(plan, 'full')` (Screen 2).
 *
 * Mirrors the existing inline mapping from hub-menu.ts:11-36, extracted into
 * this module so the day-plan menu's "Full Day Plan" handler (Wave 3) can call
 * a single helper instead of duplicating the chunk/task projection.
 *
 * Returns `undefined` when no plan exists -- the renderer's no-plan branch
 * handles that case unchanged.
 */
export function buildFullDayPlanView(
	dailyPlanService?: DailyPlanService,
): DailyPlanView | undefined {
	if (!dailyPlanService) return undefined;
	const plan = dailyPlanService.getTodayPlan();
	if (!plan) return undefined;

	const { chunks } = dailyPlanService.getPlanWithChunks(plan.id);

	return {
		date: plan.date,
		chunks: chunks.map((c) => {
			const mappedTasks = c.tasks.map((t) => ({
				label: t.label,
				isLocked: t.isLocked,
				status: t.status,
				// Phase 10 (D-15):
				predictedMaxSeconds: t.predictedMaxSeconds ?? null,
				predictedConfidence: t.predictedConfidence ?? null,
			}));
			const rollup = computeChunkRollup(c.startTime, c.endTime, mappedTasks);
			return {
				label: c.label,
				startTime: c.startTime,
				endTime: c.endTime,
				isTaskSlot: c.isTaskSlot,
				status: c.status,
				tasks: mappedTasks,
				slotDurationMinutes: rollup.slotDurationMinutes,
				predictedSumMinutes: rollup.predictedSumMinutes,
			};
		}),
	};
}

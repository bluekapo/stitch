// Phase 10 Plan 02 Task 3: PredictionService.
//
// The "predict" half of the predict-then-plan architecture (D-01). Takes the
// pool of pending tasks from DailyPlanService, walks each task's paired
// (predicted, actual) history via the sourceTaskId chain (D-13), builds a
// raw-row user prompt with 7-day global activity context (D-10/D-11/D-12),
// calls the LLM ONCE for the whole batch (D-08), and returns a
// Map<taskId, PredictionItem>.
//
// D-06 contract: this service NEVER throws. Retry once on failure, fall
// through to an empty Map on second failure. Plan generation must never be
// blocked by a prediction bug.
//
// Pitfall 5 guard: NO DailyPlanService dependency — that direction would
// cause a DI cycle (DailyPlanService consumes PredictionService).

import { format, subDays } from 'date-fns';
import { eq, gte, inArray, or } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { StitchDb } from '../db/index.js';
import { taskDurations, tasks } from '../db/schema.js';
import {
	buildPredictionUserPrompt,
	type GlobalActivityRow,
	PREDICTION_SYSTEM_PROMPT,
	type TaskDurationRow,
} from '../prompts/prediction.js';
import { withSoul } from '../prompts/soul.js';
import type { LlmProvider } from '../providers/llm.js';
import { PredictionResponseSchema } from '../schemas/prediction.js';
import type { PredictionItem, PredictionResponse } from '../types/prediction.js';
import type { DayTreeService } from './day-tree-service.js';
import type { TaskService } from './task-service.js';

export interface PredictionPendingTask {
	id: number;
	name: string;
	sourceTaskId: number | null;
}

export class PredictionService {
	// D-12 (Phase 12): `logger` is now REQUIRED — fail-closed DI. Previously
	// optional, but every caller in the app already passes one.
	constructor(
		private db: StitchDb,
		private taskService: TaskService,
		private dayTreeService: DayTreeService,
		private llmProvider: LlmProvider,
		private logger: Logger,
	) {}

	/**
	 * Predict durations for every task in the pending pool.
	 *
	 * Contract: ALWAYS resolves. On total failure (D-06: retry-once-then-
	 * fall-through), returns an empty Map and logs a warning. NEVER throws.
	 *
	 * Batched: one LLM call for ALL tasks (D-08), not one call per task.
	 */
	async predictDurations(
		pendingTasks: PredictionPendingTask[],
		reqLogger?: Logger,
	): Promise<Map<number, PredictionItem>> {
		const log = reqLogger ?? this.logger;
		if (pendingTasks.length === 0) return new Map();

		log.debug({ count: pendingTasks.length }, 'prediction.predict:start');

		// ---------- PHASE 1: gather context (sync) ----------
		const perTaskHistory = new Map<number, TaskDurationRow[]>();
		for (const t of pendingTasks) {
			perTaskHistory.set(t.id, this.gatherHistoryFeed(t));
		}
		const now = new Date();
		const globalActivity = this.gatherGlobalActivity(now);
		const tree = this.dayTreeService.getTree() ?? null;

		const userPrompt = buildPredictionUserPrompt({
			pendingTasks,
			perTaskHistory,
			globalActivity,
			tree,
			now,
		});

		// ---------- PHASE 2: LLM call with D-06 retry-once ----------
		let result: PredictionResponse;
		try {
			result = await this.callLlm(userPrompt);
		} catch (firstErr) {
			log.warn({ err: firstErr }, 'prediction LLM call failed, retrying once (D-06)');
			try {
				result = await this.callLlm(userPrompt);
			} catch (secondErr) {
				log.warn(
					{ err: secondErr },
					'prediction LLM call failed twice, falling through with empty Map (D-06)',
				);
				return new Map();
			}
		}

		// ---------- PHASE 3: hallucination defense + Map assembly ----------
		// Mirror of daily-plan-service.ts:90-92,143 — build Set, filter, assemble.
		const validTaskIds = new Set(pendingTasks.map((t) => t.id));
		const map = new Map<number, PredictionItem>();
		for (const p of result.predictions) {
			if (validTaskIds.has(p.taskId)) {
				map.set(p.taskId, p);
			}
		}
		return map;
	}

	private async callLlm(userPrompt: string): Promise<PredictionResponse> {
		return this.llmProvider.complete({
			messages: [
				{ role: 'system', content: withSoul(PREDICTION_SYSTEM_PROMPT) },
				{ role: 'user', content: userPrompt },
			],
			schema: PredictionResponseSchema,
			schemaName: 'prediction',
			temperature: 0.3,
			// Phase 07 lesson + D-02 belt-and-suspenders: grammar enforcement requires
			// thinking:false. With thinking:true, llama-server silently produces
			// unstructured text and the safeParse fails downstream.
			thinking: false,
			// Per-task reasoning is wordy (chain-of-thought + classification sentence).
			// 2048 leaves headroom for ~10-15 pending tasks per batch.
			maxTokens: 2048,
		});
	}

	/**
	 * Walk the sourceTaskId chain (D-13, depth-1) to gather paired history
	 * for the template + all its instances.
	 */
	private gatherHistoryFeed(task: PredictionPendingTask): TaskDurationRow[] {
		// Identify the template (or self if not an instance).
		const templateId = task.sourceTaskId ?? task.id;

		// Gather all task IDs in the chain: template + instances. Single OR query.
		const chainRows = this.db
			.select({ id: tasks.id })
			.from(tasks)
			.where(or(eq(tasks.id, templateId), eq(tasks.sourceTaskId, templateId)))
			.all();
		const chainIds = chainRows.map((r) => r.id);

		if (chainIds.length === 0) return [];

		// Gather all task_durations rows for any task in the chain, chronological.
		const rows = this.db
			.select()
			.from(taskDurations)
			.where(inArray(taskDurations.taskId, chainIds))
			.orderBy(taskDurations.startedAt)
			.all();

		return rows.map((r) => ({
			id: r.id,
			taskId: r.taskId,
			durationSeconds: r.durationSeconds,
			outcome: (r.outcome ?? 'completed') as 'completed' | 'skipped' | 'postponed',
			predictedMinSeconds: r.predictedMinSeconds ?? null,
			predictedMaxSeconds: r.predictedMaxSeconds ?? null,
			predictedConfidence: (r.predictedConfidence ?? null) as 'low' | 'medium' | 'high' | null,
			startedAt: r.startedAt,
		}));
	}

	/**
	 * Gather the last 7 days of task_durations across ALL tasks (D-10/D-11/D-12).
	 * Includes skipped/postponed rows — chronic procrastination signal.
	 */
	private gatherGlobalActivity(now: Date): GlobalActivityRow[] {
		const sevenDaysAgo = format(subDays(now, 7), 'yyyy-MM-dd HH:mm:ss');

		const rows = this.db
			.select()
			.from(taskDurations)
			.where(gte(taskDurations.startedAt, sevenDaysAgo))
			.orderBy(taskDurations.startedAt)
			.all();

		// In-JS task name lookup via taskService.list() — single query, not a join.
		const allTasks = this.taskService.list();
		const nameById = new Map(allTasks.map((t) => [t.id, t.name]));

		return rows.map((r) => ({
			id: r.id,
			taskId: r.taskId,
			durationSeconds: r.durationSeconds,
			outcome: (r.outcome ?? 'completed') as 'completed' | 'skipped' | 'postponed',
			predictedMinSeconds: r.predictedMinSeconds ?? null,
			predictedMaxSeconds: r.predictedMaxSeconds ?? null,
			predictedConfidence: (r.predictedConfidence ?? null) as 'low' | 'medium' | 'high' | null,
			startedAt: r.startedAt,
			taskName: nameById.get(r.taskId) ?? `(deleted task #${r.taskId})`,
		}));
	}
}

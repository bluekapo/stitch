import { format } from 'date-fns';
import { asc, eq, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { StitchDb } from '../db/index.js';
import { chunkTasks, dailyPlans, planChunks, tasks } from '../db/schema.js';
import { withSoul } from '../prompts/soul.js';
import type { LlmProvider } from '../providers/llm.js';
import { ChunkPlanLlmSchema } from '../schemas/daily-plan.js';
import type { ChunkTask, DailyPlan, PlanChunk } from '../types/daily-plan.js';
import type { DayTree } from '../types/day-tree.js';
import type { PredictionItem } from '../types/prediction.js';
import type { DayTreeService } from './day-tree-service.js';
import type { PredictionService } from './prediction-service.js';
import type { TaskService } from './task-service.js';

export class DailyPlanService {
	constructor(
		private db: StitchDb,
		private dayTreeService: DayTreeService,
		private taskService: TaskService,
		private llmProvider: LlmProvider,
		// Phase 10 (D-01): predict-then-plan. PredictionService injected so
		// generatePlan can call predictDurations BEFORE the plan LLM call and
		// BEFORE the db.transaction opens. See PHASE 1.5 below for the Pitfall 4
		// regression guard.
		private predictionService: PredictionService,
		// D-12 (Phase 12): REQUIRED pino logger. Child-scoped in buildApp so
		// every DailyPlanService log line carries `service=DailyPlanService`.
		private logger: Logger,
	) {}

	private getTodayDateString(): string {
		return format(new Date(), 'yyyy-MM-dd');
	}

	getTodayPlan(): DailyPlan | undefined {
		const row = this.db
			.select()
			.from(dailyPlans)
			.where(eq(dailyPlans.date, this.getTodayDateString()))
			.get();
		return row as DailyPlan | undefined;
	}

	/**
	 * Phase 11 (D-04, D-06): structural-completeness post-processing.
	 *
	 * The plan LLM consistently drops fixed (non-task-slot) branches that have
	 * no tasks. This is a structural invariant we own -- synthesize empty chunks
	 * for any fixed branch absent from the LLM result, inserted at chronologically
	 * correct position by startTime.
	 *
	 * Only fixed branches (isTaskSlot=false) get this guarantee. Task-slot branches
	 * the LLM dropped are intentional (e.g., a work block with no pending tasks
	 * may legitimately be omitted).
	 *
	 * D-06: preserves LLM ordering for LLM-emitted chunks. Synthesized chunks are
	 * spliced in at their chronological position based on startTime (HH:MM strings
	 * sort lexically as time).
	 *
	 * Pitfall 4 compliant: pure function, no DB access, safe to call outside and
	 * before the db.transaction callback.
	 */
	private mergeWithFixedBranches(
		llmChunks: Array<{
			branchName: string;
			label: string;
			startTime: string;
			endTime: string;
			isTaskSlot: boolean;
			tasks: Array<{ taskId: number; label: string; isLocked: boolean }>;
		}>,
		tree: DayTree,
	): Array<{
		branchName: string;
		label: string;
		startTime: string;
		endTime: string;
		isTaskSlot: boolean;
		tasks: Array<{ taskId: number; label: string; isLocked: boolean }>;
	}> {
		const presentBranchNames = new Set(llmChunks.map((c) => c.branchName));
		const synthesized = tree.branches
			.filter((b) => !b.isTaskSlot && !presentBranchNames.has(b.name))
			.map((b) => ({
				branchName: b.name,
				label: b.name,
				startTime: b.startTime,
				endTime: b.endTime,
				isTaskSlot: false,
				tasks: [] as Array<{ taskId: number; label: string; isLocked: boolean }>,
			}));
		const merged = [...llmChunks, ...synthesized];
		// Sort by startTime -- HH:MM strings sort lexically as time.
		merged.sort((a, b) => (a.startTime < b.startTime ? -1 : a.startTime > b.startTime ? 1 : 0));
		return merged;
	}

	getPlanWithChunks(planId: number): { chunks: (PlanChunk & { tasks: ChunkTask[] })[] } {
		const chunks = this.db
			.select()
			.from(planChunks)
			.where(eq(planChunks.planId, planId))
			.orderBy(asc(planChunks.sortOrder))
			.all() as PlanChunk[];

		const chunksWithTasks = chunks.map((chunk) => {
			const tasks = this.db
				.select()
				.from(chunkTasks)
				.where(eq(chunkTasks.chunkId, chunk.id))
				.orderBy(asc(chunkTasks.sortOrder))
				.all() as ChunkTask[];
			return { ...chunk, tasks };
		});

		return { chunks: chunksWithTasks };
	}

	async generatePlan(
		date: string,
		reqLogger?: Logger,
	): Promise<DailyPlan & { chunks: PlanChunk[] }> {
		const log = reqLogger ?? this.logger;
		log.debug({ date }, 'dailyPlan.generate:start');
		// =====================================================================
		// PHASE 1: Read context (sync, OUTSIDE transaction)
		// =====================================================================
		const treeRow = this.dayTreeService.getTreeRow();
		if (!treeRow) {
			throw new Error('No day tree found.');
		}

		const { id: dayTreeId, tree } = treeRow;

		const allTasks = this.taskService.list();
		const pendingTasks = allTasks.filter((t) => t.status === 'pending' || t.status === 'active');

		// =====================================================================
		// PHASE 1.5: Prediction LLM call (async, OUTSIDE transaction — Pitfall 4)
		//
		// Per D-01 predict-then-plan, this call resolves BEFORE the plan LLM call
		// and BEFORE any DB write. PredictionService.predictDurations() has a D-06
		// contract of "always resolves, never throws" — the try/catch below is
		// defensive belt-and-suspenders (see 10-RESEARCH.md Pitfall 2 regression
		// warning). On total failure, we fall back to an empty Map and plan
		// generation continues with null prediction columns on chunk_tasks rows.
		// Plan generation is NEVER blocked by a prediction failure.
		//
		// CRITICAL: This await MUST stay OUTSIDE db.transaction(). Drizzle's
		// better-sqlite3 driver is synchronous; awaiting inside the transaction
		// callback silently corrupts state. See daily-plan-service.ts PHASE 3
		// comment below and 10-RESEARCH.md Pitfall 2 / Pitfall 4.
		// =====================================================================
		let predictions: Map<number, PredictionItem>;
		try {
			predictions = await this.predictionService.predictDurations(
				pendingTasks.map((t) => ({
					id: t.id,
					name: t.name,
					sourceTaskId: t.sourceTaskId ?? null,
				})),
			);
		} catch {
			// PredictionService's D-06 contract guarantees no throws. This catch
			// is defensive belt-and-suspenders only. Silent fall-through is fine
			// because PredictionService already logs both retry attempts internally.
			predictions = new Map();
		}

		const { system, user } = this.buildPlanPrompt(tree, pendingTasks, predictions, date);

		// =====================================================================
		// PHASE 2: LLM call (async, OUTSIDE transaction — Pitfall 4)
		//
		// Drizzle better-sqlite3 transactions are SYNC ONLY. The SQLite
		// connection is busy-locked synchronously inside db.transaction(fn).
		// Awaiting an async call inside the callback breaks the lock and
		// produces undefined behavior. Therefore the LLM call MUST resolve
		// BEFORE we enter the transaction. This also gives us D-32 atomicity
		// for free: if the LLM call rejects, the transaction never opens, and
		// no DB state changes (the user's old chunkId attachments survive).
		// =====================================================================
		const result = await this.llmProvider.complete({
			messages: [
				{ role: 'system', content: system },
				{ role: 'user', content: user },
			],
			schema: ChunkPlanLlmSchema,
			schemaName: 'chunk_plan',
			temperature: 0.3,
			maxTokens: 2048,
			thinking: false,
		});

		// Build set of valid task IDs from pending tasks (hallucination defense
		// — Phase 07 decision: drop chunks the LLM invented for non-pending tasks)
		const validTaskIds = new Set(pendingTasks.map((t) => t.id));

		// PHASE 2.5 (Phase 11, D-04): merge LLM chunks with structural-completeness
		// invariant -- every fixed branch in the day tree MUST appear as a chunk.
		// mergeWithFixedBranches synthesizes empty chunks for fixed branches the LLM
		// dropped, sorted chronologically by startTime (D-06). Pitfall 4 compliant --
		// pure function call, runs OUTSIDE the transaction.
		const mergedChunks = this.mergeWithFixedBranches(result.chunks, tree);

		// =====================================================================
		// PHASE 3: All DB writes (sync, INSIDE db.transaction)
		//
		// The transaction wraps the D-32 reset, the dailyPlans insert, and the
		// chunk/task insert loop. If ANY statement throws (FK violation, NOT
		// NULL constraint, etc.), the entire sequence rolls back and the user's
		// chunkId attachments survive intact.
		//
		// NOTE: NO `await` keyword may appear inside this callback. Drizzle's
		// better-sqlite3 driver requires synchronous statements. Adding `await`
		// here would silently break the transaction (Pitfall 4).
		// =====================================================================
		return this.db.transaction(() => {
			// 3a. D-32 reset: clear stale chunkId/branchName for all pending tasks.
			// The new plan will reattach the ones the LLM included; the rest end
			// up with chunkId=null and branchName=null (test C in Task 1).
			//
			// We reset by IDs from pendingTasks (not a blanket UPDATE on all
			// tasks) to avoid touching completed/done tasks whose chunkId is
			// historical context for past chunks.
			for (const t of pendingTasks) {
				this.db
					.update(tasks)
					.set({
						chunkId: null,
						branchName: null,
						updatedAt: sql`(datetime('now'))`,
					})
					.where(eq(tasks.id, t.id))
					.run();
			}

			// 3a-bis. Regeneration: remove any existing plan for this date so the
			// UNIQUE(date) constraint doesn't reject the insert below. Cascades
			// (ON DELETE CASCADE on plan_chunks and chunk_tasks) clean up the rest.
			this.db.delete(dailyPlans).where(eq(dailyPlans.date, date)).run();

			// 3b. Insert the daily plan with dayTreeId FK
			const [plan] = this.db
				.insert(dailyPlans)
				.values({
					date,
					dayTreeId,
					blueprintId: null,
					status: 'active',
					llmReasoning: result.reasoning,
				})
				.returning()
				.all();

			// 3c. Insert chunks and their tasks (and dual-write tasks.chunk_id).
			// Iterates mergedChunks (LLM output + synthesized fixed-branch chunks)
			// per D-04. See PHASE 2.5 above.
			const insertedChunks: PlanChunk[] = [];
			for (let i = 0; i < mergedChunks.length; i++) {
				const chunk = mergedChunks[i];

				// Filter tasks: keep only those with valid taskIds (hallucination defense)
				const validChunkTasks = chunk.tasks.filter((t) => validTaskIds.has(t.taskId));

				// Insert the plan chunk
				const [insertedChunk] = this.db
					.insert(planChunks)
					.values({
						planId: plan.id,
						branchName: chunk.branchName,
						label: chunk.label,
						startTime: chunk.startTime,
						endTime: chunk.endTime,
						isTaskSlot: chunk.isTaskSlot,
						sortOrder: i,
						status: 'pending',
					})
					.returning()
					.all();

				// Insert chunk tasks AND dual-write tasks.chunk_id + tasks.branch_name
				// (Phase 08.3 D-14 invariant: chunk_tasks rows and tasks.chunkId stay
				// in lockstep so the scoped Tasks view -- WHERE tasks.chunk_id = ? --
				// reflects the same set as the chunk_tasks join.)
				for (let j = 0; j < validChunkTasks.length; j++) {
					const task = validChunkTasks[j];

					// Phase 10 (D-05): copy prediction columns from the Map onto the
					// new row. predictions.get() is sync — safe inside the transaction
					// callback. Missing entries (D-06 fall-through) produce all-null
					// columns. The Map is closure-captured from PHASE 1.5.
					const pred = predictions.get(task.taskId);

					this.db
						.insert(chunkTasks)
						.values({
							chunkId: insertedChunk.id,
							taskId: task.taskId,
							label: task.label,
							isLocked: task.isLocked,
							sortOrder: j,
							status: 'pending',
							predictedMinSeconds: pred?.predicted_min_seconds ?? null,
							predictedMaxSeconds: pred?.predicted_max_seconds ?? null,
							predictedConfidence: pred?.confidence ?? null,
						})
						.run();

					// Dual-write tasks.chunk_id + tasks.branch_name. Skip taskId<=0
					// (Phase 07 decision: taskId=0 maps to null for fixed blueprint
					// blocks; validTaskIds filter above already drops these, but the
					// guard is belt-and-suspenders against future regressions).
					if (task.taskId && task.taskId > 0) {
						this.db
							.update(tasks)
							.set({
								chunkId: insertedChunk.id,
								branchName: chunk.branchName,
								updatedAt: sql`(datetime('now'))`,
							})
							.where(eq(tasks.id, task.taskId))
							.run();
					}
				}

				insertedChunks.push(insertedChunk as PlanChunk);
			}

			log.debug({ planId: plan.id, chunks: insertedChunks.length }, 'dailyPlan.generate:done');
			return { ...(plan as DailyPlan), chunks: insertedChunks };
		});
	}

	async ensureTodayPlan(reqLogger?: Logger): Promise<DailyPlan | undefined> {
		const log = reqLogger ?? this.logger;
		const today = this.getTodayDateString();

		const existing = this.getTodayPlan();
		if (existing) {
			log.debug({ date: today, planId: existing.id }, 'dailyPlan.ensureToday:existing');
			return existing;
		}

		const tree = this.dayTreeService.getTree();
		if (!tree) {
			log.debug({ date: today }, 'dailyPlan.ensureToday:noTree');
			return undefined;
		}

		return this.generatePlan(today, reqLogger);
	}

	private buildPlanPrompt(
		tree: DayTree,
		pendingTasks: {
			id: number;
			name: string;
			isEssential: boolean;
			postponeCount: number;
			deadline: string | null;
		}[],
		predictions: Map<number, PredictionItem>,
		today: string,
	): { system: string; user: string } {
		const treeText = tree.branches
			.map((b) => {
				const type = b.isTaskSlot ? 'TASK SLOT' : 'FIXED';
				const items =
					b.items?.map((item) => `  ${item.type.toUpperCase()}: ${item.label}`).join('\n') ?? '';
				return `${b.name} (${b.startTime}-${b.endTime}) [${type}]${items ? `\n${items}` : ''}`;
			})
			.join('\n\n');

		const taskText = pendingTasks
			.map((t) => {
				const flags: string[] = [];
				if (t.isEssential) flags.push('ESSENTIAL');
				if (t.postponeCount > 0) flags.push(`postponed ${t.postponeCount}x`);
				if (t.deadline) flags.push(`deadline: ${t.deadline}`);

				// Phase 10 (D-05): inline duration annotation so the plan LLM sees the
				// prediction and uses it for chunk packing. Max is shown, per D-15/D-16.
				const pred = predictions.get(t.id);
				if (pred) {
					const minutes = Math.round(pred.predicted_max_seconds / 60);
					flags.push(`predicted ~${minutes}min (${pred.confidence})`);
				}

				return `  ID:${t.id} "${t.name}" ${flags.join(', ')}`;
			})
			.join('\n');

		return {
			system:
				withSoul(`You are a daily planner. Create a day plan by assigning tasks to the day tree's task-slot branches.

Rules:
- For each branch with isTaskSlot=true, create one or more chunks and assign tasks from the pending pool.
- ESSENTIAL tasks MUST be assigned first. Set isLocked=true for them.
- Tasks with higher postponeCount get priority.
- Tasks with deadlines today or earlier get high priority.
- You may split long task-slot branches into multiple chunks for better pacing.
- Non-task-slot branches become informational chunks with empty tasks arrays.
- Each chunk must have a valid branchName matching a branch in the tree.
- Order chunks by startTime.
- If fewer tasks than capacity, create fewer chunks with available tasks.
- Tasks may have a "predicted ~Xmin (confidence)" annotation. Use this estimate when packing chunks so the chunk's task sum does not exceed the slot duration.
- Today's date: ${today}

Terminology:
- A BRANCH is a structural time period from the day tree. A CHUNK is a group of tasks you create within a branch. One branch can have multiple chunks.`),
			user: `Day tree:\n${treeText}\n\nPending tasks:\n${taskText}`,
		};
	}
}

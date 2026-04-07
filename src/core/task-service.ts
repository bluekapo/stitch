import { desc, eq, sql, sum } from 'drizzle-orm';
import type { StitchDb } from '../db/index.js';
import { chunkTasks, tasks, taskDurations } from '../db/schema.js';
import type { CreateTaskInput, TaskDetail, TaskListItem } from '../types/task.js';

export class TaskService {
	constructor(private db: StitchDb) {}

	create(input: CreateTaskInput): { id: number; name: string } {
		const rows = this.db
			.insert(tasks)
			.values({
				name: input.name,
				description: input.description,
				isEssential: input.isEssential ?? false,
				taskType: input.taskType ?? 'ad-hoc',
				recurrenceDay: input.recurrenceDay,
				deadline: input.deadline,
				sourceTaskId: input.sourceTaskId,
				// Phase 08.3: chunk attachment (D-16 fallback applied by callers).
				// Defaults to null when omitted, preserving existing test expectations.
				chunkId: input.chunkId ?? null,
				branchName: input.branchName ?? null,
			})
			.returning({ id: tasks.id, name: tasks.name })
			.all();
		return rows[0];
	}

	list() {
		return this.db.select().from(tasks).all();
	}

	/**
	 * Phase 08.3: scoped task list for the current chunk view (Screen 3).
	 * Returns only tasks whose chunk_id matches `chunkId`. Tasks with
	 * chunk_id = NULL are NOT included -- they only appear in the All Tasks
	 * drill-down view.
	 *
	 * Returns the TaskListItem shape directly so callers do not need to map.
	 */
	listForChunk(chunkId: number): TaskListItem[] {
		return this.db
			.select({
				id: tasks.id,
				name: tasks.name,
				status: tasks.status,
				isEssential: tasks.isEssential,
				timerStartedAt: tasks.timerStartedAt,
			})
			.from(tasks)
			.where(eq(tasks.chunkId, chunkId))
			.all();
	}

	getById(id: number) {
		return this.db.select().from(tasks).where(eq(tasks.id, id)).get();
	}

	update(
		id: number,
		data: {
			name?: string;
			description?: string;
			status?: 'pending' | 'active' | 'completed' | 'skipped';
		},
	) {
		const task = this.getById(id);
		if (!task) throw new Error('Task not found.');
		// Essential tasks block name/description changes but allow status changes (e.g., completion)
		if (task.isEssential && (data.name !== undefined || data.description !== undefined)) {
			throw new Error('Cannot modify a locked task.');
		}
		this.db
			.update(tasks)
			.set({ ...data, updatedAt: sql`(datetime('now'))` })
			.where(eq(tasks.id, id))
			.run();
	}

	delete(id: number) {
		const task = this.getById(id);
		if (!task) throw new Error('Task not found.');
		if (task.isEssential) throw new Error('Cannot delete a locked task.');
		this.db.delete(tasks).where(eq(tasks.id, id)).run();
	}

	startTimer(id: number) {
		const task = this.getById(id);
		if (!task) throw new Error('Task not found.');
		if (task.timerStartedAt) throw new Error('Timer already running on this task.');
		this.db
			.update(tasks)
			.set({
				timerStartedAt: new Date().toISOString(),
				status: 'active',
				updatedAt: sql`(datetime('now'))`,
			})
			.where(eq(tasks.id, id))
			.run();
	}

	/**
	 * Phase 10 (Plan 10-03 Task 1): look up the most recent chunk_tasks row
	 * for this task to get its prediction columns. Used by stopTimer/skip/
	 * postpone to pair (predicted, actual) in the task_durations row.
	 *
	 * Strategy: `ORDER BY chunk_tasks.id DESC LIMIT 1` gets the most recent row.
	 * Plan regeneration (Phase 07 D-32 reset) overwrites chunk_tasks rows, so
	 * the most recent row is the live one. See 10-RESEARCH.md Pitfall 4.
	 *
	 * Returns all-null if no chunk_tasks row exists (unattached task) or if
	 * the row's prediction columns are null (prediction fell through per D-06).
	 */
	private lookupActivePrediction(taskId: number): {
		min: number | null;
		max: number | null;
		confidence: 'low' | 'medium' | 'high' | null;
	} {
		const row = this.db
			.select({
				min: chunkTasks.predictedMinSeconds,
				max: chunkTasks.predictedMaxSeconds,
				confidence: chunkTasks.predictedConfidence,
			})
			.from(chunkTasks)
			.where(eq(chunkTasks.taskId, taskId))
			.orderBy(desc(chunkTasks.id))
			.limit(1)
			.get();

		if (!row) return { min: null, max: null, confidence: null };
		return {
			min: row.min ?? null,
			max: row.max ?? null,
			confidence: (row.confidence ?? null) as 'low' | 'medium' | 'high' | null,
		};
	}

	stopTimer(id: number): number {
		const task = this.getById(id);
		if (!task) throw new Error('Task not found.');
		if (!task.timerStartedAt) throw new Error('No timer running on this task.');

		const elapsed = Date.now() - new Date(task.timerStartedAt).getTime();
		const durationSeconds = Math.floor(elapsed / 1000);

		// Phase 10 (D-21/D-23): copy prediction columns from the active chunk_tasks
		// row so the (predicted, actual) pair is persisted together for future prompts.
		const pred = this.lookupActivePrediction(id);

		this.db
			.insert(taskDurations)
			.values({
				taskId: id,
				durationSeconds,
				outcome: 'completed',
				predictedMinSeconds: pred.min,
				predictedMaxSeconds: pred.max,
				predictedConfidence: pred.confidence,
				startedAt: task.timerStartedAt,
			})
			.run();

		this.db
			.update(tasks)
			.set({
				timerStartedAt: null,
				updatedAt: sql`(datetime('now'))`,
			})
			.where(eq(tasks.id, id))
			.run();

		return durationSeconds;
	}

	postpone(id: number) {
		const task = this.getById(id);
		if (!task) throw new Error('Task not found.');
		if (task.isEssential) throw new Error('Cannot postpone a locked task.');

		// Phase 10 (D-22): write a task_durations row with null actual + outcome
		// discriminator so chronic procrastination is visible to PredictionService.
		const pred = this.lookupActivePrediction(id);
		const now = new Date().toISOString();
		this.db
			.insert(taskDurations)
			.values({
				taskId: id,
				durationSeconds: null,
				outcome: 'postponed',
				predictedMinSeconds: pred.min,
				predictedMaxSeconds: pred.max,
				predictedConfidence: pred.confidence,
				startedAt: now,
			})
			.run();

		this.db
			.update(tasks)
			.set({
				postponeCount: sql`postpone_count + 1`,
				status: 'pending',
				updatedAt: sql`(datetime('now'))`,
			})
			.where(eq(tasks.id, id))
			.run();
	}

	/**
	 * Phase 10 (D-22): explicit skip. Writes a task_durations row with
	 * outcome='skipped' and null duration_seconds so PredictionService sees
	 * the skip event in global activity (chronic procrastination signal).
	 *
	 * This replaces the previous pattern of calling
	 * `taskService.update(id, { status: 'skipped' })` which did not write a
	 * task_durations row. Callers (check-in-service, future UI) should switch
	 * to this explicit method.
	 */
	skip(id: number) {
		const task = this.getById(id);
		if (!task) throw new Error('Task not found.');

		// Phase 10 (D-22): prediction copy.
		const pred = this.lookupActivePrediction(id);
		const now = new Date().toISOString();
		this.db
			.insert(taskDurations)
			.values({
				taskId: id,
				durationSeconds: null,
				outcome: 'skipped',
				predictedMinSeconds: pred.min,
				predictedMaxSeconds: pred.max,
				predictedConfidence: pred.confidence,
				startedAt: now,
			})
			.run();

		this.db
			.update(tasks)
			.set({
				status: 'skipped',
				updatedAt: sql`(datetime('now'))`,
			})
			.where(eq(tasks.id, id))
			.run();
	}

	getTaskDetail(id: number): TaskDetail | undefined {
		const task = this.getById(id);
		if (!task) return undefined;

		const result = this.db
			.select({ total: sum(taskDurations.durationSeconds) })
			.from(taskDurations)
			.where(eq(taskDurations.taskId, id))
			.get();

		const totalDurationSeconds = result?.total != null ? Number(result.total) : null;

		return {
			id: task.id,
			name: task.name,
			description: task.description ?? null,
			status: task.status,
			isEssential: task.isEssential,
			postponeCount: task.postponeCount,
			timerStartedAt: task.timerStartedAt,
			createdAt: task.createdAt,
			totalDurationSeconds,
		};
	}

	getRecurringTemplates(type: 'daily' | 'weekly') {
		return this.db.select().from(tasks)
			.where(eq(tasks.taskType, type))
			.all();
	}

	hasInstanceForDate(sourceTaskId: number, dateStr: string): boolean {
		const row = this.db.select({ id: tasks.id }).from(tasks)
			.where(
				sql`source_task_id = ${sourceTaskId} AND date(created_at) = ${dateStr}`,
			)
			.get();
		return !!row;
	}

	createInstance(template: { id: number; name: string; description: string | null; isEssential: boolean }, dateStr: string) {
		return this.create({
			name: template.name,
			description: template.description ?? undefined,
			isEssential: template.isEssential,
			taskType: 'one-time',
			sourceTaskId: template.id,
		});
	}

	checkOrphanedTimers() {
		return this.db
			.select()
			.from(tasks)
			.where(sql`timer_started_at IS NOT NULL`)
			.all();
	}
}

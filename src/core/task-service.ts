import { eq, sql, sum } from 'drizzle-orm';
import type { StitchDb } from '../db/index.js';
import { tasks, taskDurations } from '../db/schema.js';
import type { CreateTaskInput, TaskDetail } from '../types/task.js';

export class TaskService {
	constructor(private db: StitchDb) {}

	create(input: CreateTaskInput): { id: number; name: string } {
		const rows = this.db
			.insert(tasks)
			.values({
				name: input.name,
				description: input.description,
				isEssential: input.isEssential ?? false,
			})
			.returning({ id: tasks.id, name: tasks.name })
			.all();
		return rows[0];
	}

	list() {
		return this.db.select().from(tasks).all();
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
		if (task.isEssential) throw new Error('Cannot modify a locked task.');
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

	stopTimer(id: number): number {
		const task = this.getById(id);
		if (!task) throw new Error('Task not found.');
		if (!task.timerStartedAt) throw new Error('No timer running on this task.');

		const elapsed = Date.now() - new Date(task.timerStartedAt).getTime();
		const durationSeconds = Math.floor(elapsed / 1000);

		this.db
			.insert(taskDurations)
			.values({
				taskId: id,
				durationSeconds,
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

	checkOrphanedTimers() {
		return this.db
			.select()
			.from(tasks)
			.where(sql`timer_started_at IS NOT NULL`)
			.all();
	}
}

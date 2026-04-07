import type Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { TaskService } from '../../src/core/task-service.js';
import { chunkTasks, dailyPlans, planChunks, taskDurations, tasks } from '../../src/db/schema.js';
import { createTaskSchema } from '../../src/types/task.js';
import type { StitchDb } from '../../src/db/index.js';

describe('TaskService', () => {
	let db: StitchDb;
	let service: TaskService;

	beforeEach(() => {
		db = createTestDb();
		service = new TaskService(db);
	});

	describe('create', () => {
		it('inserts a task and returns id + name', () => {
			const result = service.create({ name: 'Buy groceries', isEssential: false });
			expect(result).toHaveProperty('id');
			expect(result.id).toBeGreaterThan(0);
			expect(result.name).toBe('Buy groceries');
		});

		it('validates input via Zod schema before calling service', () => {
			const parsed = createTaskSchema.parse({ name: 'Test task' });
			expect(parsed.isEssential).toBe(false);
			expect(parsed.name).toBe('Test task');
		});

		it('creates essential tasks', () => {
			const result = service.create({ name: 'Morning workout', isEssential: true });
			const task = service.getById(result.id);
			expect(task?.isEssential).toBe(true);
		});

		it('creates tasks with description', () => {
			const result = service.create({
				name: 'Buy groceries',
				description: 'Get milk and eggs',
				isEssential: false,
			});
			const task = service.getById(result.id);
			expect(task?.description).toBe('Get milk and eggs');
		});

		describe('chunk_id + branch_name attachment (Phase 08.3)', () => {
			// Helper: seed plan_chunks rows so tasks.chunk_id FK references resolve.
			function seedPlanChunks(chunkIds: number[]) {
				// biome-ignore lint/suspicious/noExplicitAny: direct sqlite access for FK seed setup
				const sqlite = (db as any).$client as Database.Database;
				sqlite.exec(`INSERT INTO daily_plans (id, date) VALUES (1, '2026-04-06');`);
				for (const id of chunkIds) {
					sqlite
						.prepare(
							`INSERT INTO plan_chunks (id, plan_id, branch_name, label, start_time, end_time)
							 VALUES (?, 1, 'Morning', 'Test chunk', '08:00', '10:00')`,
						)
						.run(id);
				}
			}

			it('persists chunkId and branchName when both provided', () => {
				seedPlanChunks([5]);
				const result = service.create({
					name: 'Attached task',
					chunkId: 5,
					branchName: 'Morning',
				});
				const row = db.select().from(tasks).where(eq(tasks.id, result.id)).get();
				expect(row?.chunkId).toBe(5);
				expect(row?.branchName).toBe('Morning');
			});

			it('persists NULL chunkId and branchName when neither provided (existing behavior preserved)', () => {
				const result = service.create({ name: 'Unattached task' });
				const row = db.select().from(tasks).where(eq(tasks.id, result.id)).get();
				expect(row?.chunkId).toBeNull();
				expect(row?.branchName).toBeNull();
			});

			it('persists NULL when chunkId is explicitly null', () => {
				const result = service.create({
					name: 'Explicit null',
					chunkId: null,
					branchName: null,
				});
				const row = db.select().from(tasks).where(eq(tasks.id, result.id)).get();
				expect(row?.chunkId).toBeNull();
				expect(row?.branchName).toBeNull();
			});
		});
	});

	describe('list', () => {
		it('returns empty array initially', () => {
			const tasks = service.list();
			expect(tasks).toEqual([]);
		});

		it('returns tasks after create', () => {
			service.create({ name: 'Task A', isEssential: false });
			service.create({ name: 'Task B', isEssential: false });
			const tasks = service.list();
			expect(tasks).toHaveLength(2);
			expect(tasks[0].name).toBe('Task A');
			expect(tasks[1].name).toBe('Task B');
		});
	});

	describe('getById', () => {
		it('returns task by id', () => {
			const created = service.create({ name: 'My task', isEssential: false });
			const task = service.getById(created.id);
			expect(task).toBeDefined();
			expect(task?.name).toBe('My task');
		});

		it('returns undefined for non-existent id', () => {
			const task = service.getById(999);
			expect(task).toBeUndefined();
		});
	});

	describe('update', () => {
		it('updates task name', () => {
			const created = service.create({ name: 'Old name', isEssential: false });
			service.update(created.id, { name: 'New name' });
			const task = service.getById(created.id);
			expect(task?.name).toBe('New name');
		});

		it('throws "Cannot modify a locked task." for essential task', () => {
			const created = service.create({ name: 'Workout', isEssential: true });
			expect(() => service.update(created.id, { name: 'Skip workout' })).toThrow(
				'Cannot modify a locked task.',
			);
		});

		it('throws "Task not found." for non-existent id', () => {
			expect(() => service.update(999, { name: 'Ghost' })).toThrow('Task not found.');
		});
	});

	describe('delete', () => {
		it('deletes a task', () => {
			const created = service.create({ name: 'Temp task', isEssential: false });
			service.delete(created.id);
			const task = service.getById(created.id);
			expect(task).toBeUndefined();
		});

		it('throws "Cannot delete a locked task." for essential task', () => {
			const created = service.create({ name: 'Workout', isEssential: true });
			expect(() => service.delete(created.id)).toThrow('Cannot delete a locked task.');
		});

		it('throws "Task not found." for non-existent id', () => {
			expect(() => service.delete(999)).toThrow('Task not found.');
		});

		it('cascade deletes durations when task deleted', () => {
			const created = service.create({ name: 'Timed task', isEssential: false });
			service.startTimer(created.id);
			service.stopTimer(created.id);
			// Task has a duration record now
			const detail = service.getTaskDetail(created.id);
			expect(detail?.totalDurationSeconds).not.toBeNull();
			// Delete the task -- durations should cascade
			service.delete(created.id);
			expect(service.getById(created.id)).toBeUndefined();
		});
	});

	describe('startTimer', () => {
		it('sets timerStartedAt and status to active', () => {
			const created = service.create({ name: 'Work', isEssential: false });
			service.startTimer(created.id);
			const task = service.getById(created.id);
			expect(task?.timerStartedAt).toBeDefined();
			expect(task?.timerStartedAt).not.toBeNull();
			expect(task?.status).toBe('active');
		});

		it('throws "Timer already running on this task." if already running', () => {
			const created = service.create({ name: 'Work', isEssential: false });
			service.startTimer(created.id);
			expect(() => service.startTimer(created.id)).toThrow(
				'Timer already running on this task.',
			);
		});

		it('throws "Task not found." for non-existent id', () => {
			expect(() => service.startTimer(999)).toThrow('Task not found.');
		});
	});

	describe('stopTimer', () => {
		it('returns durationSeconds >= 0 and clears timerStartedAt', () => {
			const created = service.create({ name: 'Work', isEssential: false });
			service.startTimer(created.id);
			const duration = service.stopTimer(created.id);
			expect(duration).toBeGreaterThanOrEqual(0);
			const task = service.getById(created.id);
			expect(task?.timerStartedAt).toBeNull();
		});

		it('inserts a task_durations row', () => {
			const created = service.create({ name: 'Work', isEssential: false });
			service.startTimer(created.id);
			service.stopTimer(created.id);
			const detail = service.getTaskDetail(created.id);
			expect(detail?.totalDurationSeconds).not.toBeNull();
			expect(detail!.totalDurationSeconds).toBeGreaterThanOrEqual(0);
		});

		it('throws "No timer running on this task." if no timer', () => {
			const created = service.create({ name: 'Work', isEssential: false });
			expect(() => service.stopTimer(created.id)).toThrow(
				'No timer running on this task.',
			);
		});

		it('throws "Task not found." for non-existent id', () => {
			expect(() => service.stopTimer(999)).toThrow('Task not found.');
		});
	});

	describe('postpone', () => {
		it('increments postponeCount', () => {
			const created = service.create({ name: 'Boring task', isEssential: false });
			service.postpone(created.id);
			const task = service.getById(created.id);
			expect(task?.postponeCount).toBe(1);
			service.postpone(created.id);
			const task2 = service.getById(created.id);
			expect(task2?.postponeCount).toBe(2);
		});

		it('resets status to pending', () => {
			const created = service.create({ name: 'Active task', isEssential: false });
			service.startTimer(created.id);
			service.stopTimer(created.id);
			// Status might be something other than pending after timer stop
			service.postpone(created.id);
			const task = service.getById(created.id);
			expect(task?.status).toBe('pending');
		});

		it('throws "Cannot postpone a locked task." for essential task', () => {
			const created = service.create({ name: 'Workout', isEssential: true });
			expect(() => service.postpone(created.id)).toThrow(
				'Cannot postpone a locked task.',
			);
		});

		it('throws "Task not found." for non-existent id', () => {
			expect(() => service.postpone(999)).toThrow('Task not found.');
		});
	});

	describe('getTaskDetail', () => {
		it('returns totalDurationSeconds summed from durations', () => {
			const created = service.create({ name: 'Tracked task', isEssential: false });
			// First timer session
			service.startTimer(created.id);
			service.stopTimer(created.id);
			// Second timer session
			service.startTimer(created.id);
			service.stopTimer(created.id);
			const detail = service.getTaskDetail(created.id);
			expect(detail).toBeDefined();
			expect(detail!.totalDurationSeconds).not.toBeNull();
			expect(detail!.totalDurationSeconds).toBeGreaterThanOrEqual(0);
		});

		it('returns null totalDurationSeconds when no durations', () => {
			const created = service.create({ name: 'Untracked task', isEssential: false });
			const detail = service.getTaskDetail(created.id);
			expect(detail).toBeDefined();
			expect(detail!.totalDurationSeconds).toBeNull();
		});

		it('returns undefined for non-existent task', () => {
			const detail = service.getTaskDetail(999);
			expect(detail).toBeUndefined();
		});
	});

	describe('task types (TASK-04)', () => {
		it('creates task with taskType="daily" and retrieves it', () => {
			const result = service.create({ name: 'Morning workout', isEssential: false, taskType: 'daily' });
			const task = service.getById(result.id);
			expect(task?.taskType).toBe('daily');
		});

		it('creates task with taskType="weekly" and recurrenceDay=1', () => {
			const result = service.create({ name: 'Team standup', isEssential: false, taskType: 'weekly', recurrenceDay: 1 });
			const task = service.getById(result.id);
			expect(task?.taskType).toBe('weekly');
			expect(task?.recurrenceDay).toBe(1);
		});

		it('creates task with deadline ISO string', () => {
			const deadline = '2026-04-15T17:00:00.000Z';
			const result = service.create({ name: 'File taxes', isEssential: false, taskType: 'one-time', deadline });
			const task = service.getById(result.id);
			expect(task?.deadline).toBe(deadline);
		});

		it('creates task with sourceTaskId linking to another task', () => {
			const template = service.create({ name: 'Daily workout', isEssential: false, taskType: 'daily' });
			const instance = service.create({ name: 'Daily workout', isEssential: false, taskType: 'one-time', sourceTaskId: template.id });
			const task = service.getById(instance.id);
			expect(task?.sourceTaskId).toBe(template.id);
		});

		it('defaults taskType to "ad-hoc" and others to null when not provided', () => {
			const result = service.create({ name: 'Quick task', isEssential: false });
			const task = service.getById(result.id);
			expect(task?.taskType).toBe('ad-hoc');
			expect(task?.recurrenceDay).toBeNull();
			expect(task?.deadline).toBeNull();
			expect(task?.sourceTaskId).toBeNull();
		});
	});

	describe('recurring helpers', () => {
		it('getRecurringTemplates returns daily tasks', () => {
			service.create({ name: 'Workout', isEssential: false, taskType: 'daily' });
			service.create({ name: 'Ad-hoc thing', isEssential: false });
			const dailies = service.getRecurringTemplates('daily');
			expect(dailies).toHaveLength(1);
			expect(dailies[0].name).toBe('Workout');
		});

		it('getRecurringTemplates returns weekly tasks', () => {
			service.create({ name: 'Team meeting', isEssential: false, taskType: 'weekly', recurrenceDay: 1 });
			service.create({ name: 'Ad-hoc', isEssential: false });
			const weeklies = service.getRecurringTemplates('weekly');
			expect(weeklies).toHaveLength(1);
			expect(weeklies[0].name).toBe('Team meeting');
		});

		it('hasInstanceForDate returns false when no instance exists', () => {
			const template = service.create({ name: 'Daily workout', isEssential: false, taskType: 'daily' });
			const result = service.hasInstanceForDate(template.id, '2026-04-05');
			expect(result).toBe(false);
		});

		it('hasInstanceForDate returns true when instance exists for date', () => {
			const template = service.create({ name: 'Daily workout', isEssential: false, taskType: 'daily' });
			service.create({ name: 'Daily workout', isEssential: false, taskType: 'one-time', sourceTaskId: template.id });
			const today = new Date().toISOString().split('T')[0];
			const result = service.hasInstanceForDate(template.id, today);
			expect(result).toBe(true);
		});

		it('createInstance creates a one-time task linked to template', () => {
			const template = service.create({ name: 'Daily workout', isEssential: true, taskType: 'daily' });
			const templateTask = service.getById(template.id)!;
			const instance = service.createInstance(templateTask, '2026-04-05');
			const task = service.getById(instance.id);
			expect(task?.name).toBe('Daily workout');
			expect(task?.taskType).toBe('one-time');
			expect(task?.sourceTaskId).toBe(template.id);
			expect(task?.isEssential).toBe(true);
		});
	});

	describe('checkOrphanedTimers', () => {
		it('returns tasks with running timers', () => {
			const t1 = service.create({ name: 'Task 1', isEssential: false });
			const t2 = service.create({ name: 'Task 2', isEssential: false });
			service.startTimer(t1.id);
			const orphans = service.checkOrphanedTimers();
			expect(orphans).toHaveLength(1);
			expect(orphans[0].id).toBe(t1.id);
		});

		it('returns empty array when no running timers', () => {
			service.create({ name: 'Task 1', isEssential: false });
			const orphans = service.checkOrphanedTimers();
			expect(orphans).toEqual([]);
		});
	});

	describe('listForChunk (Phase 08.3)', () => {
		// Helper: seed plan_chunks rows so tasks.chunk_id FK references resolve.
		// foreign_keys is ON in createTestDb, so the parent rows must exist.
		function seedPlanChunks(chunkIds: number[]) {
			// biome-ignore lint/suspicious/noExplicitAny: direct sqlite access for FK seed setup
			const sqlite = (db as any).$client as Database.Database;
			sqlite.exec(`INSERT INTO daily_plans (id, date) VALUES (1, '2026-04-06');`);
			for (const id of chunkIds) {
				sqlite
					.prepare(
						`INSERT INTO plan_chunks (id, plan_id, branch_name, label, start_time, end_time)
						 VALUES (?, 1, 'TestBranch', 'Test chunk', '08:00', '10:00')`,
					)
					.run(id);
			}
		}

		it('returns only tasks with matching chunk_id', () => {
			seedPlanChunks([5, 7]);
			const t1 = service.create({ name: 'In chunk 5 - A', isEssential: false });
			const t2 = service.create({ name: 'In chunk 5 - B', isEssential: false });
			const t3 = service.create({ name: 'In chunk 7', isEssential: false });
			db.update(tasks).set({ chunkId: 5 }).where(eq(tasks.id, t1.id)).run();
			db.update(tasks).set({ chunkId: 5 }).where(eq(tasks.id, t2.id)).run();
			db.update(tasks).set({ chunkId: 7 }).where(eq(tasks.id, t3.id)).run();

			const inChunk5 = service.listForChunk(5);
			expect(inChunk5).toHaveLength(2);
			expect(inChunk5.map((t) => t.name).sort()).toEqual([
				'In chunk 5 - A',
				'In chunk 5 - B',
			]);
		});

		it('returns empty array when no tasks match the given chunk_id', () => {
			seedPlanChunks([1]);
			const t1 = service.create({ name: 'In chunk 1', isEssential: false });
			db.update(tasks).set({ chunkId: 1 }).where(eq(tasks.id, t1.id)).run();

			expect(service.listForChunk(999)).toEqual([]);
		});

		it('ignores tasks with chunk_id = NULL (only attached tasks come back)', () => {
			seedPlanChunks([3]);
			const attached = service.create({ name: 'Attached', isEssential: false });
			service.create({ name: 'Unattached A', isEssential: false });
			service.create({ name: 'Unattached B', isEssential: false });
			db.update(tasks).set({ chunkId: 3 }).where(eq(tasks.id, attached.id)).run();

			const result = service.listForChunk(3);
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('Attached');
		});

		it('returns the TaskListItem shape (id, name, status, isEssential, timerStartedAt)', () => {
			seedPlanChunks([2]);
			const created = service.create({ name: 'Locked task', isEssential: true });
			db.update(tasks).set({ chunkId: 2 }).where(eq(tasks.id, created.id)).run();

			const result = service.listForChunk(2);
			expect(result).toHaveLength(1);
			expect(result[0]).toMatchObject({
				id: created.id,
				name: 'Locked task',
				status: 'pending',
				isEssential: true,
				timerStartedAt: null,
			});
		});

		it('list() (All Tasks) still returns ALL tasks regardless of chunk_id (unchanged behavior)', () => {
			seedPlanChunks([1]);
			const attached = service.create({ name: 'Attached', isEssential: false });
			service.create({ name: 'Unattached A', isEssential: false });
			service.create({ name: 'Unattached B', isEssential: false });
			db.update(tasks).set({ chunkId: 1 }).where(eq(tasks.id, attached.id)).run();

			expect(service.list()).toHaveLength(3);
		});
	});

	describe('Phase 10: prediction pairing (D-21, D-22, D-23)', () => {
		/**
		 * Helper: insert a plan + chunk + chunk_task row for a task, with prediction
		 * columns filled in. Returns the chunk_tasks.id for assertion sanity.
		 */
		function attachTaskToChunkWithPrediction(
			taskId: number,
			min: number | null = 600,
			max: number | null = 1800,
			conf: 'low' | 'medium' | 'high' | null = 'medium',
		) {
			const [plan] = db
				.insert(dailyPlans)
				.values({
					date: '2026-04-07',
					dayTreeId: null,
					blueprintId: null,
					status: 'active',
				})
				.returning()
				.all();

			const [chunk] = db
				.insert(planChunks)
				.values({
					planId: plan.id,
					branchName: '',
					label: 'test chunk',
					startTime: '09:00',
					endTime: '10:00',
					isTaskSlot: true,
					sortOrder: 0,
					status: 'pending',
				})
				.returning()
				.all();

			const [ct] = db
				.insert(chunkTasks)
				.values({
					chunkId: chunk.id,
					taskId,
					label: 'test task',
					isLocked: false,
					sortOrder: 0,
					status: 'pending',
					predictedMinSeconds: min,
					predictedMaxSeconds: max,
					predictedConfidence: conf,
				})
				.returning()
				.all();

			return ct.id;
		}

		it('stopTimer copies prediction from chunk_tasks (PLAN-07.11)', async () => {
			const t = service.create({ name: 'Task A' });
			attachTaskToChunkWithPrediction(t.id, 600, 1800, 'medium');

			service.startTimer(t.id);
			await new Promise((r) => setTimeout(r, 10));
			service.stopTimer(t.id);

			const row = db
				.select()
				.from(taskDurations)
				.where(eq(taskDurations.taskId, t.id))
				.get();
			expect(row).toBeDefined();
			expect(row?.outcome).toBe('completed');
			expect(row?.predictedMinSeconds).toBe(600);
			expect(row?.predictedMaxSeconds).toBe(1800);
			expect(row?.predictedConfidence).toBe('medium');
			expect(row?.durationSeconds).not.toBeNull();
			expect(row?.durationSeconds ?? -1).toBeGreaterThanOrEqual(0);
		});

		it('skip writes task_durations row with null actual (PLAN-07.12)', () => {
			const t = service.create({ name: 'Task B' });
			attachTaskToChunkWithPrediction(t.id, 300, 900, 'low');

			service.skip(t.id);

			const row = db
				.select()
				.from(taskDurations)
				.where(eq(taskDurations.taskId, t.id))
				.get();
			expect(row).toBeDefined();
			expect(row?.outcome).toBe('skipped');
			expect(row?.durationSeconds).toBeNull();
			expect(row?.predictedMinSeconds).toBe(300);
			expect(row?.predictedMaxSeconds).toBe(900);
			expect(row?.predictedConfidence).toBe('low');

			// Task status was also updated
			const task = service.getById(t.id);
			expect(task?.status).toBe('skipped');
		});

		it('postpone writes task_durations row with null actual (PLAN-07.13)', () => {
			const t = service.create({ name: 'Task C' });
			attachTaskToChunkWithPrediction(t.id, 1200, 2400, 'high');

			service.postpone(t.id);

			const row = db
				.select()
				.from(taskDurations)
				.where(eq(taskDurations.taskId, t.id))
				.get();
			expect(row).toBeDefined();
			expect(row?.outcome).toBe('postponed');
			expect(row?.durationSeconds).toBeNull();
			expect(row?.predictedMinSeconds).toBe(1200);
			expect(row?.predictedMaxSeconds).toBe(2400);
			expect(row?.predictedConfidence).toBe('high');

			// Status reset to pending (postpone semantics), postponeCount incremented
			const task = service.getById(t.id);
			expect(task?.status).toBe('pending');
			expect(task?.postponeCount).toBe(1);
		});

		it('skip/postpone on unattached task writes null predictions', () => {
			const t1 = service.create({ name: 'Skip unattached' });
			const t2 = service.create({ name: 'Postpone unattached' });

			service.skip(t1.id);
			service.postpone(t2.id);

			const skipRow = db
				.select()
				.from(taskDurations)
				.where(eq(taskDurations.taskId, t1.id))
				.get();
			const postponeRow = db
				.select()
				.from(taskDurations)
				.where(eq(taskDurations.taskId, t2.id))
				.get();

			expect(skipRow?.outcome).toBe('skipped');
			expect(skipRow?.predictedMinSeconds).toBeNull();
			expect(skipRow?.predictedMaxSeconds).toBeNull();
			expect(skipRow?.predictedConfidence).toBeNull();
			expect(postponeRow?.outcome).toBe('postponed');
			expect(postponeRow?.predictedMinSeconds).toBeNull();
			expect(postponeRow?.predictedMaxSeconds).toBeNull();
			expect(postponeRow?.predictedConfidence).toBeNull();
		});

		it('stopTimer on task with null predictions (D-06 fall-through) writes null prediction columns', async () => {
			const t = service.create({ name: 'Null pred task' });
			attachTaskToChunkWithPrediction(t.id, null, null, null);

			service.startTimer(t.id);
			await new Promise((r) => setTimeout(r, 10));
			service.stopTimer(t.id);

			const row = db
				.select()
				.from(taskDurations)
				.where(eq(taskDurations.taskId, t.id))
				.get();
			expect(row?.outcome).toBe('completed');
			expect(row?.predictedMinSeconds).toBeNull();
			expect(row?.predictedMaxSeconds).toBeNull();
			expect(row?.predictedConfidence).toBeNull();
		});
	});
});

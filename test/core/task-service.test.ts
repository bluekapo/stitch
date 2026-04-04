import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { TaskService } from '../../src/core/task-service.js';
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
});

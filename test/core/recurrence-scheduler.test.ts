import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { TaskService } from '../../src/core/task-service.js';
import { RecurrenceScheduler } from '../../src/core/recurrence-scheduler.js';

describe('RecurrenceScheduler', () => {
	let service: TaskService;
	let scheduler: RecurrenceScheduler;

	beforeEach(() => {
		const db = createTestDb();
		service = new TaskService(db);
		scheduler = new RecurrenceScheduler(service);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('generateDailyTasks', () => {
		it('creates one-time instances for all daily templates', () => {
			service.create({ name: 'Workout', taskType: 'daily' });
			service.create({ name: 'Read', taskType: 'daily' });

			const created = scheduler.generateDailyTasks();

			expect(created).toBe(2);
			const allTasks = service.list();
			const instances = allTasks.filter(t => t.taskType === 'one-time' && t.sourceTaskId !== null);
			expect(instances).toHaveLength(2);
		});

		it('skips templates that already have an instance for today (idempotency)', () => {
			service.create({ name: 'Workout', taskType: 'daily' });

			const first = scheduler.generateDailyTasks();
			const second = scheduler.generateDailyTasks();

			expect(first).toBe(1);
			expect(second).toBe(0);
			const allTasks = service.list();
			const instances = allTasks.filter(t => t.taskType === 'one-time' && t.sourceTaskId !== null);
			expect(instances).toHaveLength(1);
		});

		it('does not create instances for weekly or ad-hoc templates', () => {
			service.create({ name: 'Weekly Review', taskType: 'weekly', recurrenceDay: 1 });
			service.create({ name: 'One-off errand', taskType: 'ad-hoc' });

			const created = scheduler.generateDailyTasks();

			expect(created).toBe(0);
		});
	});

	describe('generateWeeklyTasks', () => {
		it('creates instances only for templates whose recurrenceDay matches today', () => {
			// Set fake date to Wednesday (day 3)
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-04-08T10:00:00')); // Wednesday

			service.create({ name: 'Wed Meeting', taskType: 'weekly', recurrenceDay: 3 });
			service.create({ name: 'Mon Review', taskType: 'weekly', recurrenceDay: 1 });

			const created = scheduler.generateWeeklyTasks();

			expect(created).toBe(1);
			const allTasks = service.list();
			const instances = allTasks.filter(t => t.taskType === 'one-time' && t.sourceTaskId !== null);
			expect(instances).toHaveLength(1);
			expect(instances[0].name).toBe('Wed Meeting');
		});

		it('skips non-matching days', () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-04-08T10:00:00')); // Wednesday (day 3)

			service.create({ name: 'Mon Review', taskType: 'weekly', recurrenceDay: 1 });

			const created = scheduler.generateWeeklyTasks();

			expect(created).toBe(0);
		});

		it('skips templates that already have an instance for today', () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-04-08T10:00:00')); // Wednesday

			service.create({ name: 'Wed Meeting', taskType: 'weekly', recurrenceDay: 3 });

			const first = scheduler.generateWeeklyTasks();
			const second = scheduler.generateWeeklyTasks();

			expect(first).toBe(1);
			expect(second).toBe(0);
		});
	});

	describe('instance properties', () => {
		it('generated instances have taskType one-time and sourceTaskId set', () => {
			const template = service.create({ name: 'Workout', taskType: 'daily', isEssential: true });

			scheduler.generateDailyTasks();

			const allTasks = service.list();
			const instance = allTasks.find(t => t.sourceTaskId === template.id);
			expect(instance).toBeDefined();
			expect(instance!.taskType).toBe('one-time');
			expect(instance!.sourceTaskId).toBe(template.id);
		});

		it('generated instances inherit name, description, isEssential from template', () => {
			service.create({
				name: 'Workout',
				description: 'Morning exercise',
				taskType: 'daily',
				isEssential: true,
			});

			scheduler.generateDailyTasks();

			const allTasks = service.list();
			const instance = allTasks.find(t => t.taskType === 'one-time' && t.sourceTaskId !== null);
			expect(instance).toBeDefined();
			expect(instance!.name).toBe('Workout');
			expect(instance!.description).toBe('Morning exercise');
			expect(instance!.isEssential).toBe(1); // SQLite stores booleans as integers
		});
	});
});

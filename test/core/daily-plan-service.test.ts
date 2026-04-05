import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { MockLlmProvider } from '../../src/providers/mock.js';
import { BlueprintService } from '../../src/core/blueprint-service.js';
import { TaskService } from '../../src/core/task-service.js';
import { DailyPlanService } from '../../src/core/daily-plan-service.js';
import type { StitchDb } from '../../src/db/index.js';

describe('DailyPlanService', () => {
	let db: StitchDb;
	let llm: MockLlmProvider;
	let blueprintService: BlueprintService;
	let taskService: TaskService;
	let planService: DailyPlanService;
	let blueprintId: number;

	beforeEach(() => {
		db = createTestDb();
		llm = new MockLlmProvider();
		blueprintService = new BlueprintService(db);
		taskService = new TaskService(db);
		planService = new DailyPlanService(db, blueprintService, taskService, llm);

		// Set up a blueprint with one cycle containing a fixed block and a slot
		const bp = blueprintService.createBlueprint({ name: 'Test Day' });
		blueprintId = bp.id;
		const cycle = blueprintService.addCycle({
			blueprintId: bp.id,
			name: 'Morning',
			startTime: '07:00',
			endTime: '10:00',
			sortOrder: 0,
		});
		blueprintService.addTimeBlock({
			cycleId: cycle.id,
			label: 'Shower',
			startTime: '07:00',
			endTime: '07:30',
			isSlot: false,
			sortOrder: 0,
		});
		blueprintService.addTimeBlock({
			cycleId: cycle.id,
			startTime: '07:30',
			endTime: '08:30',
			isSlot: true,
			sortOrder: 1,
		});
		blueprintService.addTimeBlock({
			cycleId: cycle.id,
			startTime: '08:30',
			endTime: '10:00',
			isSlot: true,
			sortOrder: 2,
		});
		blueprintService.setActive(bp.id);
	});

	it('generates a plan with chunks matching LLM output', async () => {
		const t1 = taskService.create({ name: 'Buy groceries' });
		const t2 = taskService.create({ name: 'Read book' });

		llm.setFixture('daily_plan', {
			chunks: [
				{ taskId: 0, label: 'Shower', startTime: '07:00', endTime: '07:30', isLocked: false },
				{ taskId: t1.id, label: 'Buy groceries', startTime: '07:30', endTime: '08:30', isLocked: false },
				{ taskId: t2.id, label: 'Read book', startTime: '08:30', endTime: '10:00', isLocked: false },
			],
			reasoning: 'Assigned tasks to morning slots.',
		});

		const result = await planService.generatePlan('2026-04-05');
		const chunks = planService.getPlanChunks(result.id);

		expect(chunks).toHaveLength(3);
		expect(chunks[0].label).toBe('Shower');
		expect(chunks[0].taskId).toBeNull();
		expect(chunks[1].taskId).toBe(t1.id);
		expect(chunks[1].label).toBe('Buy groceries');
		expect(chunks[2].taskId).toBe(t2.id);
		expect(chunks[2].label).toBe('Read book');
	});

	it('marks chunks with essential tasks as isLocked=true', async () => {
		const t1 = taskService.create({ name: 'Essential task', isEssential: true });

		llm.setFixture('daily_plan', {
			chunks: [
				{ taskId: 0, label: 'Shower', startTime: '07:00', endTime: '07:30', isLocked: false },
				{ taskId: t1.id, label: 'Essential task', startTime: '07:30', endTime: '08:30', isLocked: true },
			],
			reasoning: 'Essential task placed first and locked.',
		});

		const result = await planService.generatePlan('2026-04-05');
		const chunks = planService.getPlanChunks(result.id);
		const essentialChunk = chunks.find(c => c.taskId === t1.id);

		expect(essentialChunk).toBeDefined();
		expect(essentialChunk!.isLocked).toBe(true);
	});

	it('ensureTodayPlan() creates a plan if none exists for today', async () => {
		taskService.create({ name: 'Some task' });

		llm.setFixture('daily_plan', {
			chunks: [
				{ taskId: 0, label: 'Shower', startTime: '07:00', endTime: '07:30', isLocked: false },
			],
			reasoning: 'Minimal plan.',
		});

		const plan = await planService.ensureTodayPlan();
		expect(plan).toBeDefined();

		const todayPlan = planService.getTodayPlan();
		expect(todayPlan).toBeDefined();
		expect(todayPlan!.id).toBe(plan!.id);
	});

	it('ensureTodayPlan() is idempotent -- second call returns existing plan', async () => {
		taskService.create({ name: 'Some task' });

		llm.setFixture('daily_plan', {
			chunks: [
				{ taskId: 0, label: 'Shower', startTime: '07:00', endTime: '07:30', isLocked: false },
			],
			reasoning: 'Minimal plan.',
		});

		const first = await planService.ensureTodayPlan();
		const second = await planService.ensureTodayPlan();

		expect(first!.id).toBe(second!.id);

		// Count plans in DB -- should be exactly 1
		const todayPlan = planService.getTodayPlan();
		expect(todayPlan).toBeDefined();
	});

	it('ensureTodayPlan() returns undefined when no active blueprint exists', async () => {
		// Deactivate the blueprint by deleting it
		blueprintService.deleteBlueprint(blueprintId);

		const result = await planService.ensureTodayPlan();
		expect(result).toBeUndefined();
	});

	it('getPlanChunks() returns chunks ordered by sortOrder', async () => {
		const t1 = taskService.create({ name: 'Task A' });
		const t2 = taskService.create({ name: 'Task B' });

		llm.setFixture('daily_plan', {
			chunks: [
				{ taskId: t2.id, label: 'Task B', startTime: '08:30', endTime: '10:00', isLocked: false },
				{ taskId: 0, label: 'Shower', startTime: '07:00', endTime: '07:30', isLocked: false },
				{ taskId: t1.id, label: 'Task A', startTime: '07:30', endTime: '08:30', isLocked: false },
			],
			reasoning: 'Tasks out of order in LLM output.',
		});

		const result = await planService.generatePlan('2026-04-05');
		const chunks = planService.getPlanChunks(result.id);

		// Chunks should be ordered by sortOrder (0, 1, 2) as assigned during insertion
		expect(chunks[0].sortOrder).toBeLessThan(chunks[1].sortOrder);
		expect(chunks[1].sortOrder).toBeLessThan(chunks[2].sortOrder);
	});

	it('generatePlan() drops chunks with taskId that does not exist in pending tasks', async () => {
		const t1 = taskService.create({ name: 'Real task' });

		llm.setFixture('daily_plan', {
			chunks: [
				{ taskId: 0, label: 'Shower', startTime: '07:00', endTime: '07:30', isLocked: false },
				{ taskId: t1.id, label: 'Real task', startTime: '07:30', endTime: '08:30', isLocked: false },
				{ taskId: 999, label: 'Hallucinated', startTime: '08:30', endTime: '10:00', isLocked: false },
			],
			reasoning: 'One chunk has invalid taskId.',
		});

		const result = await planService.generatePlan('2026-04-05');
		const chunks = planService.getPlanChunks(result.id);

		// The chunk with taskId=999 should be dropped, keeping 2 chunks
		expect(chunks).toHaveLength(2);
		expect(chunks.find(c => c.label === 'Hallucinated')).toBeUndefined();
	});
});

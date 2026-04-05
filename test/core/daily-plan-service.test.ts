import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { MockLlmProvider } from '../../src/providers/mock.js';
import { DayTreeService } from '../../src/core/day-tree-service.js';
import { TaskService } from '../../src/core/task-service.js';
import { DailyPlanService } from '../../src/core/daily-plan-service.js';
import { dayTrees, chunkTasks, planChunks, dailyPlans } from '../../src/db/schema.js';
import { eq, asc } from 'drizzle-orm';
import type { StitchDb } from '../../src/db/index.js';

describe('DailyPlanService', () => {
	let db: StitchDb;
	let llm: MockLlmProvider;
	let dayTreeService: DayTreeService;
	let taskService: TaskService;
	let planService: DailyPlanService;

	beforeEach(() => {
		db = createTestDb();
		llm = new MockLlmProvider();
		dayTreeService = new DayTreeService(db, llm);
		taskService = new TaskService(db);
		planService = new DailyPlanService(db, dayTreeService, taskService, llm);

		// Set up a day tree (direct DB insert to avoid LLM call)
		db.insert(dayTrees).values({
			tree: {
				branches: [
					{ name: 'Morning duties', startTime: '08:00', endTime: '10:00', isTaskSlot: true },
					{ name: 'Day branch', startTime: '10:00', endTime: '18:00', isTaskSlot: true },
					{ name: 'Dinner', startTime: '18:00', endTime: '19:00', isTaskSlot: false, items: [{ label: 'Dinner', type: 'fixed' as const }] },
				],
			},
		}).run();
	});

	it('generates plan with milestone chunks from day tree', async () => {
		const t1 = taskService.create({ name: 'Exercise' });
		const t2 = taskService.create({ name: 'Shower' });
		const t3 = taskService.create({ name: 'Code review' });

		llm.setFixture('chunk_plan', {
			chunks: [
				{
					branchName: 'Morning duties', label: 'Morning tasks', startTime: '08:00', endTime: '10:00', isTaskSlot: true,
					tasks: [
						{ taskId: t1.id, label: 'Exercise', isLocked: false },
						{ taskId: t2.id, label: 'Shower', isLocked: false },
					],
				},
				{
					branchName: 'Day branch', label: 'Work block 1', startTime: '10:00', endTime: '14:00', isTaskSlot: true,
					tasks: [{ taskId: t3.id, label: 'Code review', isLocked: true }],
				},
				{
					branchName: 'Dinner', label: 'Dinner', startTime: '18:00', endTime: '19:00', isTaskSlot: false,
					tasks: [],
				},
			],
			reasoning: 'Assigned tasks to morning and work blocks. Dinner is informational.',
		});

		const result = await planService.generatePlan('2026-04-05');

		// Should have 3 chunks
		expect(result.chunks).toHaveLength(3);
		expect(result.chunks[0].label).toBe('Morning tasks');
		expect(result.chunks[0].branchName).toBe('Morning duties');
		expect(result.chunks[1].label).toBe('Work block 1');
		expect(result.chunks[2].label).toBe('Dinner');

		// Verify chunkTasks created in DB
		const morningTasks = db.select().from(chunkTasks)
			.where(eq(chunkTasks.chunkId, result.chunks[0].id))
			.orderBy(asc(chunkTasks.sortOrder))
			.all();
		expect(morningTasks).toHaveLength(2);
		expect(morningTasks[0].label).toBe('Exercise');
		expect(morningTasks[1].label).toBe('Shower');

		const workTasks = db.select().from(chunkTasks)
			.where(eq(chunkTasks.chunkId, result.chunks[1].id))
			.all();
		expect(workTasks).toHaveLength(1);
		expect(workTasks[0].label).toBe('Code review');
	});

	it('dailyPlans row has dayTreeId set to the day_trees row ID', async () => {
		const t1 = taskService.create({ name: 'Task A' });

		llm.setFixture('chunk_plan', {
			chunks: [
				{
					branchName: 'Morning duties', label: 'Morning', startTime: '08:00', endTime: '10:00', isTaskSlot: true,
					tasks: [{ taskId: t1.id, label: 'Task A', isLocked: false }],
				},
			],
			reasoning: 'Minimal plan.',
		});

		const result = await planService.generatePlan('2026-04-05');

		const planRow = db.select().from(dailyPlans).where(eq(dailyPlans.id, result.id)).get();
		expect(planRow).toBeDefined();
		expect(planRow!.dayTreeId).not.toBeNull();

		// dayTreeId should match the day_trees row
		const treeRow = db.select().from(dayTrees).get();
		expect(planRow!.dayTreeId).toBe(treeRow!.id);
	});

	it('informational chunks have empty task arrays', async () => {
		const t1 = taskService.create({ name: 'Task A' });

		llm.setFixture('chunk_plan', {
			chunks: [
				{
					branchName: 'Morning duties', label: 'Morning', startTime: '08:00', endTime: '10:00', isTaskSlot: true,
					tasks: [{ taskId: t1.id, label: 'Task A', isLocked: false }],
				},
				{
					branchName: 'Dinner', label: 'Dinner', startTime: '18:00', endTime: '19:00', isTaskSlot: false,
					tasks: [],
				},
			],
			reasoning: 'Dinner is informational.',
		});

		const result = await planService.generatePlan('2026-04-05');

		const dinnerChunk = result.chunks.find(c => c.label === 'Dinner');
		expect(dinnerChunk).toBeDefined();
		expect(dinnerChunk!.isTaskSlot).toBe(false);

		// Verify no chunkTasks for dinner chunk
		const dinnerTasks = db.select().from(chunkTasks)
			.where(eq(chunkTasks.chunkId, dinnerChunk!.id))
			.all();
		expect(dinnerTasks).toHaveLength(0);
	});

	it('essential tasks marked isLocked in chunk tasks', async () => {
		const t1 = taskService.create({ name: 'Critical task', isEssential: true });

		llm.setFixture('chunk_plan', {
			chunks: [
				{
					branchName: 'Morning duties', label: 'Morning', startTime: '08:00', endTime: '10:00', isTaskSlot: true,
					tasks: [{ taskId: t1.id, label: 'Critical task', isLocked: true }],
				},
			],
			reasoning: 'Essential task locked.',
		});

		const result = await planService.generatePlan('2026-04-05');

		const tasks = db.select().from(chunkTasks)
			.where(eq(chunkTasks.chunkId, result.chunks[0].id))
			.all();
		expect(tasks).toHaveLength(1);
		expect(tasks[0].isLocked).toBe(true);
		expect(tasks[0].taskId).toBe(t1.id);
	});

	it('LLM can split long branch into multiple chunks', async () => {
		const t1 = taskService.create({ name: 'Task 1' });
		const t2 = taskService.create({ name: 'Task 2' });
		const t3 = taskService.create({ name: 'Task 3' });

		llm.setFixture('chunk_plan', {
			chunks: [
				{
					branchName: 'Day branch', label: 'Work block 1', startTime: '10:00', endTime: '14:00', isTaskSlot: true,
					tasks: [{ taskId: t1.id, label: 'Task 1', isLocked: false }, { taskId: t2.id, label: 'Task 2', isLocked: false }],
				},
				{
					branchName: 'Day branch', label: 'Work block 2', startTime: '14:00', endTime: '18:00', isTaskSlot: true,
					tasks: [{ taskId: t3.id, label: 'Task 3', isLocked: false }],
				},
			],
			reasoning: 'Split day branch into two work blocks.',
		});

		const result = await planService.generatePlan('2026-04-05');

		// Both chunks should have branchName='Day branch'
		const dayCycleChunks = result.chunks.filter(c => c.branchName === 'Day branch');
		expect(dayCycleChunks).toHaveLength(2);
		expect(dayCycleChunks[0].label).toBe('Work block 1');
		expect(dayCycleChunks[1].label).toBe('Work block 2');
	});

	it('drops hallucinated taskIds from chunk tasks', async () => {
		const t1 = taskService.create({ name: 'Real task' });

		llm.setFixture('chunk_plan', {
			chunks: [
				{
					branchName: 'Morning duties', label: 'Morning', startTime: '08:00', endTime: '10:00', isTaskSlot: true,
					tasks: [
						{ taskId: t1.id, label: 'Real task', isLocked: false },
						{ taskId: 999, label: 'Hallucinated task', isLocked: false },
					],
				},
			],
			reasoning: 'One task is hallucinated.',
		});

		const result = await planService.generatePlan('2026-04-05');

		const tasks = db.select().from(chunkTasks)
			.where(eq(chunkTasks.chunkId, result.chunks[0].id))
			.all();
		// Only the real task should exist; hallucinated one dropped
		expect(tasks).toHaveLength(1);
		expect(tasks[0].taskId).toBe(t1.id);
		expect(tasks[0].label).toBe('Real task');
	});

	it('ensureTodayPlan returns undefined when no tree exists', async () => {
		// Delete the day tree
		db.delete(dayTrees).run();

		const result = await planService.ensureTodayPlan();
		expect(result).toBeUndefined();
	});

	it('ensureTodayPlan is idempotent', async () => {
		const t1 = taskService.create({ name: 'Task A' });

		llm.setFixture('chunk_plan', {
			chunks: [
				{
					branchName: 'Morning duties', label: 'Morning', startTime: '08:00', endTime: '10:00', isTaskSlot: true,
					tasks: [{ taskId: t1.id, label: 'Task A', isLocked: false }],
				},
			],
			reasoning: 'Minimal plan.',
		});

		const first = await planService.ensureTodayPlan();
		const second = await planService.ensureTodayPlan();

		expect(first).toBeDefined();
		expect(first!.id).toBe(second!.id);

		// Only one plan should exist
		const plans = db.select().from(dailyPlans).all();
		expect(plans).toHaveLength(1);
	});

	it('generatePlan throws when no day tree exists', async () => {
		db.delete(dayTrees).run();

		await expect(planService.generatePlan('2026-04-05'))
			.rejects.toThrow('No day tree found.');
	});
});

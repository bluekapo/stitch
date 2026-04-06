import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { MockLlmProvider } from '../../src/providers/mock.js';
import { DayTreeService } from '../../src/core/day-tree-service.js';
import { TaskService } from '../../src/core/task-service.js';
import { DailyPlanService } from '../../src/core/daily-plan-service.js';
import { dayTrees, chunkTasks, planChunks, dailyPlans, tasks } from '../../src/db/schema.js';
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

	describe('dual-write tasks.chunk_id + branch_name (Phase 08.3)', () => {
		it('generatePlan populates tasks.chunk_id and tasks.branch_name on each attached task', async () => {
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
						branchName: 'Day branch', label: 'Work block', startTime: '10:00', endTime: '14:00', isTaskSlot: true,
						tasks: [{ taskId: t3.id, label: 'Code review', isLocked: true }],
					},
				],
				reasoning: 'Two task slot branches populated.',
			});

			const result = await planService.generatePlan('2026-04-05');
			expect(result.chunks).toHaveLength(2);

			const morningChunk = result.chunks[0];
			const workChunk = result.chunks[1];

			// Tasks 1 and 2 should be attached to morning chunk + 'Morning duties'
			const t1Row = db.select().from(tasks).where(eq(tasks.id, t1.id)).get();
			const t2Row = db.select().from(tasks).where(eq(tasks.id, t2.id)).get();
			expect(t1Row?.chunkId).toBe(morningChunk.id);
			expect(t1Row?.branchName).toBe('Morning duties');
			expect(t2Row?.chunkId).toBe(morningChunk.id);
			expect(t2Row?.branchName).toBe('Morning duties');

			// Task 3 should be attached to work chunk + 'Day branch'
			const t3Row = db.select().from(tasks).where(eq(tasks.id, t3.id)).get();
			expect(t3Row?.chunkId).toBe(workChunk.id);
			expect(t3Row?.branchName).toBe('Day branch');
		});

		it('listForChunk returns tasks attached by generatePlan (proves dual-write consistency)', async () => {
			const t1 = taskService.create({ name: 'Exercise' });
			const t2 = taskService.create({ name: 'Shower' });

			llm.setFixture('chunk_plan', {
				chunks: [
					{
						branchName: 'Morning duties', label: 'Morning', startTime: '08:00', endTime: '10:00', isTaskSlot: true,
						tasks: [
							{ taskId: t1.id, label: 'Exercise', isLocked: false },
							{ taskId: t2.id, label: 'Shower', isLocked: false },
						],
					},
				],
				reasoning: 'All in morning.',
			});

			const result = await planService.generatePlan('2026-04-05');
			const morningChunkId = result.chunks[0].id;

			const scoped = taskService.listForChunk(morningChunkId);
			expect(scoped).toHaveLength(2);
			expect(scoped.map((t) => t.name).sort()).toEqual(['Exercise', 'Shower']);
		});

		it('regenerating a plan updates tasks.chunk_id to the new chunk id', async () => {
			const t1 = taskService.create({ name: 'Exercise' });

			// First plan: assign to morning chunk
			llm.setFixture('chunk_plan', {
				chunks: [
					{
						branchName: 'Morning duties', label: 'Morning', startTime: '08:00', endTime: '10:00', isTaskSlot: true,
						tasks: [{ taskId: t1.id, label: 'Exercise', isLocked: false }],
					},
				],
				reasoning: 'First plan.',
			});
			const firstPlan = await planService.generatePlan('2026-04-05');
			const firstChunkId = firstPlan.chunks[0].id;

			const t1AfterFirst = db.select().from(tasks).where(eq(tasks.id, t1.id)).get();
			expect(t1AfterFirst?.chunkId).toBe(firstChunkId);

			// Delete the first plan (simulating regeneration teardown)
			db.delete(dailyPlans).where(eq(dailyPlans.id, firstPlan.id)).run();

			// Second plan: assign same task to a Day-branch chunk
			llm.setFixture('chunk_plan', {
				chunks: [
					{
						branchName: 'Day branch', label: 'Day work', startTime: '10:00', endTime: '14:00', isTaskSlot: true,
						tasks: [{ taskId: t1.id, label: 'Exercise', isLocked: false }],
					},
				],
				reasoning: 'Second plan moves it to day branch.',
			});
			const secondPlan = await planService.generatePlan('2026-04-06');
			const secondChunkId = secondPlan.chunks[0].id;

			expect(secondChunkId).not.toBe(firstChunkId);

			const t1AfterSecond = db.select().from(tasks).where(eq(tasks.id, t1.id)).get();
			expect(t1AfterSecond?.chunkId).toBe(secondChunkId);
			expect(t1AfterSecond?.branchName).toBe('Day branch');
		});

		it('does not attempt to update tasks.chunk_id for taskId=0 (fixed blueprint blocks)', async () => {
			// Per Phase 07 decision: taskId=0 maps to null in DB for fixed blueprint blocks.
			// Validation in generatePlan drops these because validTaskIds only contains
			// real pending task ids; the dual-write loop should never see taskId=0.
			const t1 = taskService.create({ name: 'Real task' });

			llm.setFixture('chunk_plan', {
				chunks: [
					{
						branchName: 'Morning duties', label: 'Morning', startTime: '08:00', endTime: '10:00', isTaskSlot: true,
						tasks: [
							{ taskId: t1.id, label: 'Real task', isLocked: false },
							// Hallucinated id 0 -- should be dropped by validTaskIds filter
							{ taskId: 0, label: 'Fixed block', isLocked: true },
						],
					},
				],
				reasoning: 'Dual write must not crash on taskId=0.',
			});

			// Should not throw
			const result = await planService.generatePlan('2026-04-05');
			expect(result.chunks).toHaveLength(1);

			// Real task is attached
			const t1Row = db.select().from(tasks).where(eq(tasks.id, t1.id)).get();
			expect(t1Row?.chunkId).toBe(result.chunks[0].id);
		});
	});

	it('D-32: rolls back tasks.chunkId attachment when LLM fails mid-regenerate', async () => {
		// Step 1: Successfully generate plan A so tasks have a non-null chunkId
		const t1 = taskService.create({ name: 'Exercise' });
		const t2 = taskService.create({ name: 'Code review' });

		llm.setFixture('chunk_plan', {
			chunks: [
				{
					branchName: 'Morning duties', label: 'Morning', startTime: '08:00', endTime: '10:00', isTaskSlot: true,
					tasks: [
						{ taskId: t1.id, label: 'Exercise', isLocked: false },
						{ taskId: t2.id, label: 'Code review', isLocked: false },
					],
				},
			],
			reasoning: 'Plan A baseline.',
		});

		await planService.generatePlan('2026-04-06');

		// Capture pre-regenerate state — both tasks should be attached
		const t1Before = db.select().from(tasks).where(eq(tasks.id, t1.id)).get();
		const t2Before = db.select().from(tasks).where(eq(tasks.id, t2.id)).get();
		expect(t1Before!.chunkId).not.toBeNull();
		expect(t2Before!.chunkId).not.toBeNull();
		const t1OldChunkId = t1Before!.chunkId;
		const t2OldChunkId = t2Before!.chunkId;
		const t1OldBranchName = t1Before!.branchName;
		const t2OldBranchName = t2Before!.branchName;

		// Step 2: Inject LLM failure for the regenerate call by replacing the
		// provider with a fresh mock that has NO fixture registered. The mock
		// throws "No mock fixture registered for schema: chunk_plan".
		const failingLlm = new MockLlmProvider();
		// (no setFixture call — failingLlm.complete will reject)
		const failingPlanService = new DailyPlanService(db, dayTreeService, taskService, failingLlm);

		// Step 3: Attempt regenerate, expect rejection
		await expect(failingPlanService.generatePlan('2026-04-07')).rejects.toThrow(
			/No mock fixture registered for schema: chunk_plan/,
		);

		// Step 4: Re-query tasks. Both must still be attached to the OLD plan's
		// chunks. If the LLM call were inside db.transaction(), the reset step
		// would have already committed (because Drizzle's sync transaction
		// auto-commits on each statement before the async LLM rejection),
		// orphaning these tasks. The Pitfall 4 fix (LLM outside transaction)
		// guarantees the entire reset+reassign sequence happens AFTER the LLM
		// resolves successfully — so a failed LLM call leaves state untouched.
		const t1After = db.select().from(tasks).where(eq(tasks.id, t1.id)).get();
		const t2After = db.select().from(tasks).where(eq(tasks.id, t2.id)).get();
		expect(t1After!.chunkId).toBe(t1OldChunkId);
		expect(t2After!.chunkId).toBe(t2OldChunkId);
		expect(t1After!.branchName).toBe(t1OldBranchName);
		expect(t2After!.branchName).toBe(t2OldBranchName);
	});

	it('D-32: successful regenerate resets stale chunkId then reattaches via new plan', async () => {
		// Plan A: t1 in Morning, t2+t3 in Day branch
		const t1 = taskService.create({ name: 'Exercise' });
		const t2 = taskService.create({ name: 'Code review' });
		const t3 = taskService.create({ name: 'Write doc' });

		llm.setFixture('chunk_plan', {
			chunks: [
				{
					branchName: 'Morning duties', label: 'Morning', startTime: '08:00', endTime: '10:00', isTaskSlot: true,
					tasks: [{ taskId: t1.id, label: 'Exercise', isLocked: false }],
				},
				{
					branchName: 'Day branch', label: 'Work', startTime: '10:00', endTime: '14:00', isTaskSlot: true,
					tasks: [
						{ taskId: t2.id, label: 'Code review', isLocked: false },
						{ taskId: t3.id, label: 'Write doc', isLocked: false },
					],
				},
			],
			reasoning: 'Plan A.',
		});

		const planA = await planService.generatePlan('2026-04-06');
		const planAMorningChunkId = planA.chunks[0].id;
		const planADayChunkId = planA.chunks[1].id;

		// Verify pre-state: tasks attached to plan A chunks
		const t1A = db.select().from(tasks).where(eq(tasks.id, t1.id)).get();
		expect(t1A!.chunkId).toBe(planAMorningChunkId);
		expect(db.select().from(tasks).where(eq(tasks.id, t2.id)).get()!.chunkId).toBe(planADayChunkId);
		expect(db.select().from(tasks).where(eq(tasks.id, t3.id)).get()!.chunkId).toBe(planADayChunkId);

		// Plan B: LLM swaps assignments (t1 -> Day, t2 -> Morning, t3 -> Day)
		llm.setFixture('chunk_plan', {
			chunks: [
				{
					branchName: 'Morning duties', label: 'Morning', startTime: '08:00', endTime: '10:00', isTaskSlot: true,
					tasks: [{ taskId: t2.id, label: 'Code review', isLocked: false }],
				},
				{
					branchName: 'Day branch', label: 'Work', startTime: '10:00', endTime: '14:00', isTaskSlot: true,
					tasks: [
						{ taskId: t1.id, label: 'Exercise', isLocked: false },
						{ taskId: t3.id, label: 'Write doc', isLocked: false },
					],
				},
			],
			reasoning: 'Plan B reshuffled.',
		});

		const planB = await planService.generatePlan('2026-04-07');
		const planBMorningChunkId = planB.chunks[0].id;
		const planBDayChunkId = planB.chunks[1].id;

		// New chunk IDs are different from old ones
		expect(planBMorningChunkId).not.toBe(planAMorningChunkId);
		expect(planBDayChunkId).not.toBe(planADayChunkId);

		// Tasks now point at plan B chunks (NOT plan A chunks)
		const t1B = db.select().from(tasks).where(eq(tasks.id, t1.id)).get();
		const t2B = db.select().from(tasks).where(eq(tasks.id, t2.id)).get();
		const t3B = db.select().from(tasks).where(eq(tasks.id, t3.id)).get();
		expect(t1B!.chunkId).toBe(planBDayChunkId);
		expect(t2B!.chunkId).toBe(planBMorningChunkId);
		expect(t3B!.chunkId).toBe(planBDayChunkId);
		expect(t1B!.branchName).toBe('Day branch');
		expect(t2B!.branchName).toBe('Morning duties');
		expect(t3B!.branchName).toBe('Day branch');
	});

	it('D-32: regenerate clears chunkId for tasks the new plan does not include', async () => {
		// Plan A: all 3 tasks attached
		const t1 = taskService.create({ name: 'Exercise' });
		const t2 = taskService.create({ name: 'Code review' });
		const t3 = taskService.create({ name: 'Errands' });

		llm.setFixture('chunk_plan', {
			chunks: [
				{
					branchName: 'Morning duties', label: 'Morning', startTime: '08:00', endTime: '10:00', isTaskSlot: true,
					tasks: [
						{ taskId: t1.id, label: 'Exercise', isLocked: false },
						{ taskId: t2.id, label: 'Code review', isLocked: false },
						{ taskId: t3.id, label: 'Errands', isLocked: false },
					],
				},
			],
			reasoning: 'Plan A all attached.',
		});

		await planService.generatePlan('2026-04-06');
		expect(db.select().from(tasks).where(eq(tasks.id, t1.id)).get()!.chunkId).not.toBeNull();
		expect(db.select().from(tasks).where(eq(tasks.id, t2.id)).get()!.chunkId).not.toBeNull();
		expect(db.select().from(tasks).where(eq(tasks.id, t3.id)).get()!.chunkId).not.toBeNull();

		// Plan B: LLM only includes t1, drops t2 and t3
		llm.setFixture('chunk_plan', {
			chunks: [
				{
					branchName: 'Morning duties', label: 'Morning', startTime: '08:00', endTime: '10:00', isTaskSlot: true,
					tasks: [{ taskId: t1.id, label: 'Exercise', isLocked: false }],
				},
			],
			reasoning: 'Plan B trimmed — only essential.',
		});

		await planService.generatePlan('2026-04-07');

		// t1 still attached (to new plan), t2 and t3 reset to null (D-32)
		expect(db.select().from(tasks).where(eq(tasks.id, t1.id)).get()!.chunkId).not.toBeNull();
		expect(db.select().from(tasks).where(eq(tasks.id, t2.id)).get()!.chunkId).toBeNull();
		expect(db.select().from(tasks).where(eq(tasks.id, t3.id)).get()!.chunkId).toBeNull();
		expect(db.select().from(tasks).where(eq(tasks.id, t2.id)).get()!.branchName).toBeNull();
		expect(db.select().from(tasks).where(eq(tasks.id, t3.id)).get()!.branchName).toBeNull();
	});
});

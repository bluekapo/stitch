import type Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { routeTextInput } from '../../src/channels/telegram/handlers/text-router.js';
import type { CheckInService } from '../../src/core/check-in-service.js';
import type { PlanChunkWithTasks } from '../../src/core/current-chunk.js';
import type { DailyPlanService } from '../../src/core/daily-plan-service.js';
import { DayTreeService } from '../../src/core/day-tree-service.js';
import { IntentClassifierService } from '../../src/core/intent-classifier.js';
import { TaskParserService } from '../../src/core/task-parser.js';
import { TaskService } from '../../src/core/task-service.js';
import type { StitchDb } from '../../src/db/index.js';
import { dayTrees, tasks } from '../../src/db/schema.js';
import { MockLlmProvider } from '../../src/providers/mock.js';
import { createTestDb } from '../helpers/db.js';
import { createTestLogger } from '../helpers/logger.js';

const SAMPLE_TREE = {
	branches: [
		{
			name: 'Wake up',
			startTime: '07:00',
			endTime: '08:00',
			isTaskSlot: false,
			items: [{ label: 'Wake up', type: 'fixed' as const }],
		},
		{ name: 'Morning duties', startTime: '08:00', endTime: '10:00', isTaskSlot: true },
		{
			name: 'Day branch',
			startTime: '10:00',
			endTime: '21:00',
			isTaskSlot: true,
			items: [{ label: 'Games allowed 16-21', type: 'rule' as const }],
		},
		{
			name: 'Dinner',
			startTime: '21:00',
			endTime: '21:45',
			isTaskSlot: false,
			items: [{ label: 'Dinner', type: 'fixed' as const }],
		},
	],
};

describe('text-router LLM-only tree commands (D-13: classifier-routed)', () => {
	let db: StitchDb;
	let taskService: TaskService;
	let parser: TaskParserService;
	let dayTreeService: DayTreeService;
	let llm: MockLlmProvider;

	function mkClassifier(): IntentClassifierService {
		return new IntentClassifierService(llm, dayTreeService, taskService, createTestLogger());
	}

	beforeEach(() => {
		db = createTestDb();
		llm = new MockLlmProvider();
		taskService = new TaskService(db, createTestLogger());
		parser = new TaskParserService(llm, createTestLogger());
		dayTreeService = new DayTreeService(db, llm, createTestLogger());
	});

	it('D-13: "tree show" routes to classifier tree_query intent, not regex', async () => {
		// Seed a tree so tree_query can render it
		db.insert(dayTrees).values({ tree: SAMPLE_TREE }).run();

		llm.setFixture('intent_classifier', {
			intent: 'tree_query',
			confidence: 0.95,
		});

		const result = await routeTextInput('tree show', {
			taskService,
			parser,
			dayTreeService,
			intentClassifierService: mkClassifier(),
		});
		expect(result.reply).toContain('-- Day Tree --');
		expect(result.reply).toContain('Wake up');
	});

	it('D-13: "tree edit <change>" routes to classifier tree_edit intent, not regex', async () => {
		db.insert(dayTrees).values({ tree: SAMPLE_TREE }).run();

		llm.setFixture('intent_classifier', {
			intent: 'tree_edit',
			confidence: 0.95,
			modification: 'move dinner to 20:00',
		});
		llm.setFixture('day_tree', SAMPLE_TREE);

		const result = await routeTextInput('tree edit move dinner to 20:00', {
			taskService,
			parser,
			dayTreeService,
			intentClassifierService: mkClassifier(),
		});
		expect(result.reply).toContain('Day tree updated');
		expect(result.reply).toContain('-- Day Tree --');
	});
});

describe('text-router classifier dispatch (Phase 08.4)', () => {
	let db: StitchDb;
	let taskService: TaskService;
	let parser: TaskParserService;
	let llm: MockLlmProvider;
	let dayTreeService: DayTreeService;

	function mkChunk(
		id: number,
		startTime: string,
		endTime: string,
		branchName = 'Day branch',
	): PlanChunkWithTasks {
		return {
			id,
			planId: 1,
			taskId: null,
			branchName,
			label: `chunk-${id}`,
			startTime,
			endTime,
			isLocked: false,
			isTaskSlot: true,
			sortOrder: id,
			status: 'pending',
			tasks: [],
		};
	}

	function mkPlanService(chunks: PlanChunkWithTasks[]): DailyPlanService {
		return {
			getTodayPlan: () => ({ id: 1 }),
			getPlanWithChunks: () => ({ chunks }),
			// biome-ignore lint/suspicious/noExplicitAny: only the two methods are exercised by the helper
		} as any as DailyPlanService;
	}

	function mkEmptyPlanService(): DailyPlanService {
		return {
			getTodayPlan: () => undefined,
			getPlanWithChunks: () => ({ chunks: [] }),
			// biome-ignore lint/suspicious/noExplicitAny: only the two methods are exercised by the helper
		} as any as DailyPlanService;
	}

	function seedPlanChunkRows(chunkIds: number[]) {
		// biome-ignore lint/suspicious/noExplicitAny: direct sqlite for FK seed setup
		const sqlite = (db as any).$client as Database.Database;
		sqlite.exec(`INSERT OR IGNORE INTO daily_plans (id, date) VALUES (1, '2026-04-06');`);
		for (const id of chunkIds) {
			sqlite
				.prepare(
					`INSERT OR IGNORE INTO plan_chunks (id, plan_id, branch_name, label, start_time, end_time)
					 VALUES (?, 1, 'Day branch', 'Test chunk', '08:00', '23:00')`,
				)
				.run(id);
		}
	}

	function getCreatedTask(name: string) {
		return db.select().from(tasks).where(eq(tasks.name, name)).get();
	}

	beforeEach(() => {
		db = createTestDb();
		llm = new MockLlmProvider();
		taskService = new TaskService(db, createTestLogger());
		parser = new TaskParserService(llm, createTestLogger());
		dayTreeService = new DayTreeService(db, llm, createTestLogger());
	});

	function mkClassifier(): IntentClassifierService {
		return new IntentClassifierService(llm, dayTreeService, taskService, createTestLogger());
	}

	it('task_create: attaches task to chunk from classifier suggestion', async () => {
		seedPlanChunkRows([42]);

		// Wire BOTH classifier fixture (intent route) and parser fixture (Call-2 extraction)
		llm.setFixture('intent_classifier', {
			intent: 'task_create',
			confidence: 0.95,
			suggested_chunk_id: 42,
			suggested_branch_name: 'Day branch',
			is_essential: false,
		});
		llm.setFixture('task_parse', {
			name: 'Buy milk',
			taskType: 'ad-hoc',
			isEssential: false,
		});

		const intentClassifierService = mkClassifier();
		const dailyPlanService = mkPlanService([mkChunk(42, '08:00', '23:00')]);

		const result = await routeTextInput('buy milk', {
			taskService,
			parser,
			intentClassifierService,
			dailyPlanService,
		});
		expect(result.reply).toContain('Task created');
		expect(result.reply).toContain('Attached: Day branch');

		const created = getCreatedTask('Buy milk');
		expect(created?.chunkId).toBe(42);
		expect(created?.branchName).toBe('Day branch');
	});

	it('task_create: D-26 fallback when classifier returns null and current chunk exists', async () => {
		seedPlanChunkRows([50]);
		const now = new Date();
		const startHh = `${String(now.getHours()).padStart(2, '0')}:00`;
		const endHh = `${String((now.getHours() + 1) % 24).padStart(2, '0')}:00`;

		// Classifier returns null suggestion (e.g., didn't see a current-chunk match)
		llm.setFixture('intent_classifier', {
			intent: 'task_create',
			confidence: 0.9,
			suggested_chunk_id: null,
			suggested_branch_name: null,
			is_essential: false,
		});
		llm.setFixture('task_parse', {
			name: 'Sweep floor',
			taskType: 'ad-hoc',
			isEssential: false,
		});

		const intentClassifierService = mkClassifier();
		const dailyPlanService = mkPlanService([mkChunk(50, startHh, endHh, 'Day branch')]);

		await routeTextInput('sweep the floor', {
			taskService,
			parser,
			intentClassifierService,
			dailyPlanService,
		});

		// D-26 fallback path: router calls resolveCurrentChunkAttachment when
		// classifier returned null and a real dailyPlanService is wired.
		const created = getCreatedTask('Sweep floor');
		expect(created?.chunkId).toBe(50);
		expect(created?.branchName).toBe('Day branch');
	});

	it('task_create: leaves chunkId null when no chunk active and classifier returned null', async () => {
		llm.setFixture('intent_classifier', {
			intent: 'task_create',
			confidence: 0.9,
			suggested_chunk_id: null,
			suggested_branch_name: null,
			is_essential: false,
		});
		llm.setFixture('task_parse', {
			name: 'Buy bread',
			taskType: 'ad-hoc',
			isEssential: false,
		});

		const intentClassifierService = mkClassifier();
		const dailyPlanService = mkEmptyPlanService();

		const result = await routeTextInput('buy bread', {
			taskService,
			parser,
			intentClassifierService,
			dailyPlanService,
		});
		expect(result.reply).toContain('Task created');

		const created = getCreatedTask('Buy bread');
		expect(created?.chunkId).toBeNull();
		expect(created?.branchName).toBeNull();
	});

	it('task_create: is_essential=true produces "Essential task created" reply', async () => {
		seedPlanChunkRows([7]);

		llm.setFixture('intent_classifier', {
			intent: 'task_create',
			confidence: 0.92,
			suggested_chunk_id: 7,
			suggested_branch_name: 'Morning duties',
			is_essential: true,
		});
		llm.setFixture('task_parse', {
			name: 'Workout',
			taskType: 'ad-hoc',
			isEssential: false,
		});

		const intentClassifierService = mkClassifier();
		const dailyPlanService = mkPlanService([mkChunk(7, '08:00', '23:00', 'Morning duties')]);

		const result = await routeTextInput('I MUST do my workout today', {
			taskService,
			parser,
			intentClassifierService,
			dailyPlanService,
		});
		expect(result.reply).toContain('Essential task created');

		const created = getCreatedTask('Workout');
		expect(created?.chunkId).toBe(7);
		expect(created?.branchName).toBe('Morning duties');
		expect(created?.isEssential).toBe(true);
	});

	it('tree_edit: "Change dinner to 20:00" routes to dayTreeService.editTree (ROUTE-02)', async () => {
		// Seed a tree so editTree has something to edit
		db.insert(dayTrees)
			.values({
				tree: {
					branches: [
						{ name: 'Morning', startTime: '08:00', endTime: '12:00', isTaskSlot: true },
						{ name: 'Dinner', startTime: '18:00', endTime: '19:00', isTaskSlot: false },
					],
				},
			})
			.run();

		llm.setFixture('intent_classifier', {
			intent: 'tree_edit',
			confidence: 0.95,
			modification: 'move dinner to 20:00',
		});
		// editTree itself calls the LLM with day_tree fixture
		llm.setFixture('day_tree', {
			branches: [
				{ name: 'Morning', startTime: '08:00', endTime: '12:00', isTaskSlot: true },
				{ name: 'Dinner', startTime: '20:00', endTime: '21:00', isTaskSlot: false },
			],
		});

		const intentClassifierService = mkClassifier();

		const result = await routeTextInput('Change dinner to 20:00', {
			taskService,
			parser,
			dayTreeService,
			intentClassifierService,
		});

		expect(result.reply).toContain('Day tree updated');
		expect(result.reply).toContain('-- Day Tree --');
		// Crucially, NO task was created — the test would have leaked into tasks table
		expect(taskService.list()).toHaveLength(0);
	});

	it('tree_edit: "Add a reading block from 15-16" routes to dayTreeService.editTree (ROUTE-03)', async () => {
		db.insert(dayTrees)
			.values({
				tree: {
					branches: [
						{ name: 'Day branch', startTime: '10:00', endTime: '18:00', isTaskSlot: true },
					],
				},
			})
			.run();

		llm.setFixture('intent_classifier', {
			intent: 'tree_edit',
			confidence: 0.95,
			modification: 'add a reading block from 15:00 to 16:00',
		});
		llm.setFixture('day_tree', {
			branches: [
				{ name: 'Day branch', startTime: '10:00', endTime: '15:00', isTaskSlot: true },
				{ name: 'Reading', startTime: '15:00', endTime: '16:00', isTaskSlot: false },
				{ name: 'Day branch (cont)', startTime: '16:00', endTime: '18:00', isTaskSlot: true },
			],
		});

		const intentClassifierService = mkClassifier();

		const result = await routeTextInput('Add a reading block from 15-16', {
			taskService,
			parser,
			dayTreeService,
			intentClassifierService,
		});

		expect(result.reply).toContain('Day tree updated');
		expect(taskService.list()).toHaveLength(0);
	});

	it('low confidence: returns clarification reply, no DB write', async () => {
		llm.setFixture('intent_classifier', {
			intent: 'task_create',
			confidence: 0.4, // below CONFIDENCE_THRESHOLD = 0.7
			suggested_chunk_id: null,
			suggested_branch_name: null,
			is_essential: false,
			clarification: 'Did you mean to add a task or modify your day tree, Sir?',
		});

		const intentClassifierService = mkClassifier();

		const result = await routeTextInput('something ambiguous', {
			taskService,
			parser,
			intentClassifierService,
		});

		expect(result.reply).toContain('Did you mean to add a task or modify');
		expect(taskService.list()).toHaveLength(0);
	});

	it('unknown intent: returns clarification, no DB write', async () => {
		llm.setFixture('intent_classifier', {
			intent: 'unknown',
			confidence: 0.9,
			clarification: 'Apologies, Sir. I could not understand that request.',
		});

		const intentClassifierService = mkClassifier();

		const result = await routeTextInput('xyzzy', {
			taskService,
			parser,
			intentClassifierService,
		});

		expect(result.reply).toContain('Apologies, Sir');
		expect(taskService.list()).toHaveLength(0);
	});

	it('task_modify action=done routes to taskService.update with status completed (ROUTE-07)', async () => {
		// Pre-seed a pending task so the classifier's task_id points at a real row
		const task = taskService.create({ name: 'laundry' });

		llm.setFixture('intent_classifier', {
			intent: 'task_modify',
			confidence: 0.9,
			task_id: task.id,
			action: 'done',
		});

		const intentClassifierService = mkClassifier();

		const result = await routeTextInput('I finished laundry', {
			taskService,
			parser,
			intentClassifierService,
		});

		// Reply matches the existing done-reply pattern from the task_modify dispatch case
		expect(result.reply).toContain('Done: laundry');
		// DB side effect: task is now completed
		expect(taskService.getById(task.id)?.status).toBe('completed');
	});

	it('task_modify action=postpone routes to taskService.postpone (ROUTE-07)', async () => {
		const task = taskService.create({ name: 'shower' });
		const initialPostponeCount = taskService.getById(task.id)?.postponeCount ?? 0;

		llm.setFixture('intent_classifier', {
			intent: 'task_modify',
			confidence: 0.9,
			task_id: task.id,
			action: 'postpone',
		});

		const intentClassifierService = mkClassifier();

		const result = await routeTextInput('push shower to tomorrow', {
			taskService,
			parser,
			intentClassifierService,
		});

		// Reply matches the existing postpone-reply pattern
		expect(result.reply).toContain('Postponed: shower');
		// DB side effect: postpone count incremented by exactly 1
		expect(taskService.getById(task.id)?.postponeCount).toBe(initialPostponeCount + 1);
	});

	it('D-19 classifier failure: fail-closed reply, NO regex resurrection, NO silent task creation', async () => {
		// No fixture registered for intent_classifier → MockLlmProvider rejects
		const intentClassifierService = mkClassifier();

		// Spy on every mutating taskService method to prove none is invoked.
		const deleteSpy = vi.spyOn(taskService, 'delete');
		const createSpy = vi.spyOn(taskService, 'create');
		const updateSpy = vi.spyOn(taskService, 'update');
		const startSpy = vi.spyOn(taskService, 'startTimer');
		const stopSpy = vi.spyOn(taskService, 'stopTimer');
		const postponeSpy = vi.spyOn(taskService, 'postpone');

		// D-19 regression: "delete 42" no longer has a regex fast-path. The classifier
		// is invoked; the mock throws (no fixture); the catch block must return
		// fail-closed WITHOUT falling back to regex.
		const result = await routeTextInput('delete 42', {
			taskService,
			parser,
			intentClassifierService,
			logger: createTestLogger(),
		});

		expect(result.reply).toMatch(/Classification failed/i);
		// D-19: no regex resurrection — taskService.delete MUST NOT have been invoked
		expect(deleteSpy).not.toHaveBeenCalled();
		expect(createSpy).not.toHaveBeenCalled();
		expect(updateSpy).not.toHaveBeenCalled();
		expect(startSpy).not.toHaveBeenCalled();
		expect(stopSpy).not.toHaveBeenCalled();
		expect(postponeSpy).not.toHaveBeenCalled();
		expect(taskService.list()).toHaveLength(0);
	});

	// D-13 regression: "delete 42" is now classifier-routed, not regex.
	it('D-13/D-14: task_modify action=delete routes to taskService.delete', async () => {
		const target = taskService.create({ name: 'Doomed' });
		llm.setFixture('intent_classifier', {
			intent: 'task_modify',
			confidence: 0.95,
			task_id: target.id,
			action: 'delete',
		});

		const deleteSpy = vi.spyOn(taskService, 'delete');

		const result = await routeTextInput(`delete ${target.id}`, {
			taskService,
			parser,
			intentClassifierService: mkClassifier(),
			logger: createTestLogger(),
		});

		expect(result.reply).toContain('Deleted: Doomed');
		expect(deleteSpy).toHaveBeenCalledWith(target.id, expect.anything());
		expect(taskService.getById(target.id)).toBeUndefined();
	});

	it('D-14: task_modify action=start_timer routes to taskService.startTimer', async () => {
		const target = taskService.create({ name: 'Workout' });
		llm.setFixture('intent_classifier', {
			intent: 'task_modify',
			confidence: 0.95,
			task_id: target.id,
			action: 'start_timer',
		});

		const startSpy = vi.spyOn(taskService, 'startTimer');

		const result = await routeTextInput(`start ${target.id}`, {
			taskService,
			parser,
			intentClassifierService: mkClassifier(),
			logger: createTestLogger(),
		});

		expect(result.reply).toContain('Timer started: Workout');
		expect(startSpy).toHaveBeenCalledWith(target.id, expect.anything());
		// Side effect: task status is active
		expect(taskService.getById(target.id)?.timerStartedAt).toBeTruthy();
	});

	it('D-14: task_modify action=stop_timer routes to taskService.stopTimer', async () => {
		const target = taskService.create({ name: 'Workout' });
		// Start the timer first so stop has something to stop
		taskService.startTimer(target.id);

		llm.setFixture('intent_classifier', {
			intent: 'task_modify',
			confidence: 0.95,
			task_id: target.id,
			action: 'stop_timer',
		});

		const stopSpy = vi.spyOn(taskService, 'stopTimer');

		const result = await routeTextInput(`stop ${target.id}`, {
			taskService,
			parser,
			intentClassifierService: mkClassifier(),
			logger: createTestLogger(),
		});

		expect(result.reply).toContain('Timer stopped: Workout');
		expect(stopSpy).toHaveBeenCalledWith(target.id, expect.anything());
		// Side effect: timer cleared
		expect(taskService.getById(target.id)?.timerStartedAt).toBeNull();
	});

	it('D-15: stop_timer on task with no running timer produces JARVIS error via D-36 catch', async () => {
		const target = taskService.create({ name: 'Idle' });
		// NO startTimer — timer is null
		llm.setFixture('intent_classifier', {
			intent: 'task_modify',
			confidence: 0.95,
			task_id: target.id,
			action: 'stop_timer',
		});

		const result = await routeTextInput(`stop ${target.id}`, {
			taskService,
			parser,
			intentClassifierService: mkClassifier(),
			logger: createTestLogger(),
		});

		// D-36 outer service-boundary catch wraps the TaskService throw in an "Error:" reply
		expect(result.reply).toMatch(/No timer running on this task/i);
	});

	it('D-17: forceCheckIn fires for every task_modify action and task_create', async () => {
		const task1 = taskService.create({ name: 'T1' });
		const task2 = taskService.create({ name: 'T2' });
		const task3 = taskService.create({ name: 'T3' });
		taskService.startTimer(task3.id); // to make stop_timer valid later
		const task4 = taskService.create({ name: 'T4' });
		const task5 = taskService.create({ name: 'T5' });

		const forceCheckIn = vi.fn().mockResolvedValue(undefined);
		const checkInService = { forceCheckIn } as unknown as CheckInService;

		// task_create
		llm.setFixture('intent_classifier', {
			intent: 'task_create',
			confidence: 0.95,
			suggested_chunk_id: null,
			suggested_branch_name: null,
			is_essential: false,
		});
		llm.setFixture('task_parse', { name: 'New T', taskType: 'ad-hoc', isEssential: false });
		await routeTextInput('add new T', {
			taskService,
			parser,
			intentClassifierService: mkClassifier(),
			checkInService,
			logger: createTestLogger(),
		});
		expect(forceCheckIn).toHaveBeenLastCalledWith('task_action');

		// task_modify done
		llm.setFixture('intent_classifier', {
			intent: 'task_modify',
			confidence: 0.95,
			task_id: task1.id,
			action: 'done',
		});
		await routeTextInput(`done ${task1.id}`, {
			taskService,
			parser,
			intentClassifierService: mkClassifier(),
			checkInService,
			logger: createTestLogger(),
		});
		expect(forceCheckIn).toHaveBeenLastCalledWith('task_action');

		// task_modify postpone
		llm.setFixture('intent_classifier', {
			intent: 'task_modify',
			confidence: 0.95,
			task_id: task2.id,
			action: 'postpone',
		});
		await routeTextInput(`postpone ${task2.id}`, {
			taskService,
			parser,
			intentClassifierService: mkClassifier(),
			checkInService,
			logger: createTestLogger(),
		});
		expect(forceCheckIn).toHaveBeenLastCalledWith('task_action');

		// task_modify stop_timer (task3 has running timer)
		llm.setFixture('intent_classifier', {
			intent: 'task_modify',
			confidence: 0.95,
			task_id: task3.id,
			action: 'stop_timer',
		});
		await routeTextInput(`stop ${task3.id}`, {
			taskService,
			parser,
			intentClassifierService: mkClassifier(),
			checkInService,
			logger: createTestLogger(),
		});
		expect(forceCheckIn).toHaveBeenLastCalledWith('task_action');

		// task_modify start_timer
		llm.setFixture('intent_classifier', {
			intent: 'task_modify',
			confidence: 0.95,
			task_id: task4.id,
			action: 'start_timer',
		});
		await routeTextInput(`start ${task4.id}`, {
			taskService,
			parser,
			intentClassifierService: mkClassifier(),
			checkInService,
			logger: createTestLogger(),
		});
		expect(forceCheckIn).toHaveBeenLastCalledWith('task_action');

		// task_modify delete
		llm.setFixture('intent_classifier', {
			intent: 'task_modify',
			confidence: 0.95,
			task_id: task5.id,
			action: 'delete',
		});
		await routeTextInput(`delete ${task5.id}`, {
			taskService,
			parser,
			intentClassifierService: mkClassifier(),
			checkInService,
			logger: createTestLogger(),
		});
		expect(forceCheckIn).toHaveBeenLastCalledWith('task_action');

		// 6 mutations: task_create + 5 task_modify actions
		expect(forceCheckIn).toHaveBeenCalledTimes(6);
	});

	it('D-16: task_query with scope="current_chunk" narrows to current chunk tasks', async () => {
		// Set up a task attached to chunk 50 and one that is not
		seedPlanChunkRows([50]);
		const attached = taskService.create({
			name: 'In chunk',
			chunkId: 50,
			branchName: 'Day branch',
		});
		taskService.create({ name: 'Unattached' });

		const now = new Date();
		const startHh = `${String(now.getHours()).padStart(2, '0')}:00`;
		const endHh = `${String((now.getHours() + 1) % 24).padStart(2, '0')}:00`;

		llm.setFixture('intent_classifier', {
			intent: 'task_query',
			confidence: 0.95,
			scope: 'current_chunk',
		});

		const intentClassifierService = mkClassifier();
		const dailyPlanService = mkPlanService([mkChunk(50, startHh, endHh, 'Day branch')]);

		const result = await routeTextInput('show me my current chunk tasks', {
			taskService,
			parser,
			intentClassifierService,
			dailyPlanService,
			logger: createTestLogger(),
		});

		// Should render only chunk-attached task
		expect(result.reply).toContain('In chunk');
		expect(result.reply).not.toContain('Unattached');
		// Make sure we actually looked something up
		expect(attached.id).toBeGreaterThan(0);
	});

	it('D-16: task_query with scope="current_chunk" but no active chunk falls back to all tasks', async () => {
		taskService.create({ name: 'T1' });
		taskService.create({ name: 'T2' });

		llm.setFixture('intent_classifier', {
			intent: 'task_query',
			confidence: 0.95,
			scope: 'current_chunk',
		});

		const result = await routeTextInput('current chunk tasks', {
			taskService,
			parser,
			intentClassifierService: mkClassifier(),
			dailyPlanService: mkEmptyPlanService(),
			logger: createTestLogger(),
		});

		expect(result.reply).toMatch(/No current chunk/i);
		expect(result.reply).toContain('T1');
		expect(result.reply).toContain('T2');
	});
});

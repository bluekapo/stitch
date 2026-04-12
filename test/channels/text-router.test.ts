import type Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { describe, it, expect, beforeEach } from 'vitest';
import { routeTextInput, type TextRouterDeps } from '../../src/channels/telegram/handlers/text-router.js';
import { createTestDb } from '../helpers/db.js';
import { MockLlmProvider } from '../../src/providers/mock.js';
import { TaskService } from '../../src/core/task-service.js';
import { TaskParserService } from '../../src/core/task-parser.js';
import { DayTreeService } from '../../src/core/day-tree-service.js';
import { IntentClassifierService } from '../../src/core/intent-classifier.js';
import type { DailyPlanService } from '../../src/core/daily-plan-service.js';
import type { PlanChunkWithTasks } from '../../src/core/current-chunk.js';
import { dayTrees, tasks } from '../../src/db/schema.js';
import type { StitchDb } from '../../src/db/index.js';

const SAMPLE_TREE = {
	branches: [
		{ name: 'Wake up', startTime: '07:00', endTime: '08:00', isTaskSlot: false, items: [{ label: 'Wake up', type: 'fixed' as const }] },
		{ name: 'Morning duties', startTime: '08:00', endTime: '10:00', isTaskSlot: true },
		{ name: 'Day branch', startTime: '10:00', endTime: '21:00', isTaskSlot: true, items: [{ label: 'Games allowed 16-21', type: 'rule' as const }] },
		{ name: 'Dinner', startTime: '21:00', endTime: '21:45', isTaskSlot: false, items: [{ label: 'Dinner', type: 'fixed' as const }] },
	],
};

describe('text-router tree commands', () => {
	let deps: TextRouterDeps;
	let llm: MockLlmProvider;

	beforeEach(() => {
		const db = createTestDb();
		llm = new MockLlmProvider();
		const taskService = new TaskService(db);
		const parser = new TaskParserService(llm);
		const dayTreeService = new DayTreeService(db, llm);

		deps = { taskService, parser, dayTreeService };
	});

	it('tree show with no tree returns "No day tree set"', async () => {
		const result = await routeTextInput('tree show', deps);
		expect(result.reply).toContain('No day tree set');
	});

	it('tree show with existing tree returns tree view', async () => {
		// Insert tree directly into DB
		const db = createTestDb();
		db.insert(dayTrees).values({ tree: SAMPLE_TREE }).run();
		const dayTreeService = new DayTreeService(db, llm);
		const localDeps: TextRouterDeps = { ...deps, dayTreeService };

		const result = await routeTextInput('tree show', localDeps);
		expect(result.reply).toContain('-- Day Tree --');
		expect(result.reply).toContain('Wake up');
		expect(result.reply).toContain('[fixed]');
		expect(result.reply).toContain('[tasks]');
	});

	it('tree <description> calls setTree and returns tree view', async () => {
		llm.setFixture('day_tree', SAMPLE_TREE);
		const result = await routeTextInput('tree wake up at 7, morning duties until 10, day cycle 10-21', deps);
		expect(result.reply).toContain('Day tree created');
		expect(result.reply).toContain('-- Day Tree --');
	});

	it('tree edit <modification> calls editTree and returns updated view', async () => {
		// First insert a tree so editTree can find it
		const db = createTestDb();
		db.insert(dayTrees).values({ tree: SAMPLE_TREE }).run();
		const dayTreeService = new DayTreeService(db, llm);
		const localDeps: TextRouterDeps = { ...deps, dayTreeService };
		llm.setFixture('day_tree', SAMPLE_TREE);

		const result = await routeTextInput('tree edit move dinner to 20:00', localDeps);
		expect(result.reply).toContain('Day tree updated');
		expect(result.reply).toContain('-- Day Tree --');
	});

	it('tree edit is matched before tree catch-all', async () => {
		const db = createTestDb();
		db.insert(dayTrees).values({ tree: SAMPLE_TREE }).run();
		const dayTreeService = new DayTreeService(db, llm);
		const localDeps: TextRouterDeps = { ...deps, dayTreeService };
		llm.setFixture('day_tree', SAMPLE_TREE);

		// "tree edit something" should match as edit, not as set with desc "edit something"
		const result = await routeTextInput('tree edit something', localDeps);
		expect(result.reply).toContain('Day tree updated');
		expect(result.reply).not.toContain('Day tree created');
	});

	it('tree commands not matched when dayTreeService not provided', async () => {
		// Without dayTreeService, the `tree show` line cannot match. Without
		// intentClassifierService either, the router returns the configuration
		// error reply (no silent task creation — D-35 fail-closed).
		const depsWithoutTree: TextRouterDeps = {
			taskService: deps.taskService,
			parser: deps.parser,
			// no dayTreeService, no intentClassifierService
		};

		const result = await routeTextInput('tree show', depsWithoutTree);
		expect(result.reply).toContain('Error: classifier not configured.');
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
		taskService = new TaskService(db);
		parser = new TaskParserService(llm);
		dayTreeService = new DayTreeService(db, llm);
	});

	function mkClassifier(): IntentClassifierService {
		return new IntentClassifierService(llm, dayTreeService, taskService);
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
		db.insert(dayTrees).values({
			tree: {
				branches: [
					{ name: 'Morning', startTime: '08:00', endTime: '12:00', isTaskSlot: true },
					{ name: 'Dinner', startTime: '18:00', endTime: '19:00', isTaskSlot: false },
				],
			},
		}).run();

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
		db.insert(dayTrees).values({
			tree: {
				branches: [
					{ name: 'Day branch', startTime: '10:00', endTime: '18:00', isTaskSlot: true },
				],
			},
		}).run();

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
		expect(result.reply).toContain("Done: laundry");
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

	it('classifier failure (D-35): returns error with explicit-command hint, NO silent task creation', async () => {
		// No fixture registered for intent_classifier → MockLlmProvider rejects
		const intentClassifierService = mkClassifier();

		const result = await routeTextInput('whatever', {
			taskService,
			parser,
			intentClassifierService,
		});

		expect(result.reply).toContain('Classification failed');
		expect(result.reply).toContain('add &lt;name&gt;');
		expect(result.reply).toContain('tree edit');
		// CRITICAL: D-35 fail-closed — no task was silently created
		expect(taskService.list()).toHaveLength(0);
	});

	it('explicit ID-based fast-paths bypass the classifier (D-20)', async () => {
		// Pre-create a task to delete
		const t = taskService.create({ name: 'Doomed' });

		// Classifier should NEVER be called for "delete N" — verify by NOT setting
		// any fixture. If the classifier WERE invoked, the mock would throw.
		const intentClassifierService = mkClassifier();

		const result = await routeTextInput(`delete ${t.id}`, {
			taskService,
			parser,
			intentClassifierService,
		});

		expect(result.reply).toContain('Deleted: Doomed');
		// Task is gone — explicit fast-path executed without going through classifier
		expect(taskService.getById(t.id)).toBeUndefined();
	});

	it('explicit "tree show" bypasses the classifier (D-20)', async () => {
		db.insert(dayTrees).values({
			tree: {
				branches: [{ name: 'Morning', startTime: '08:00', endTime: '12:00', isTaskSlot: true }],
			},
		}).run();

		// No classifier fixture — if the dispatch ever reaches it, the mock throws
		const intentClassifierService = mkClassifier();

		const result = await routeTextInput('tree show', {
			taskService,
			parser,
			dayTreeService,
			intentClassifierService,
		});

		expect(result.reply).toContain('-- Day Tree --');
		expect(result.reply).toContain('Morning');
	});
});

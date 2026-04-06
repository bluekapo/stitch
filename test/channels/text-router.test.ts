import type Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { describe, it, expect, beforeEach } from 'vitest';
import { routeTextInput, type TextRouterDeps } from '../../src/channels/telegram/handlers/text-router.js';
import { createTestDb } from '../helpers/db.js';
import { MockLlmProvider } from '../../src/providers/mock.js';
import { TaskService } from '../../src/core/task-service.js';
import { TaskParserService } from '../../src/core/task-parser.js';
import { DayTreeService } from '../../src/core/day-tree-service.js';
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
		llm.setFixture('task_parse', {
			name: 'tree show',
			taskType: 'ad-hoc',
			isEssential: false,
		});
		const depsWithoutTree: TextRouterDeps = {
			taskService: deps.taskService,
			parser: deps.parser,
			// no dayTreeService
		};

		const result = await routeTextInput('tree show', depsWithoutTree);
		// Should fall through to NL parser, creating a task
		expect(result.reply).toContain('Task created');
	});
});

describe('text-router D-16 fallback (Phase 08.3)', () => {
	let db: StitchDb;
	let taskService: TaskService;
	let parser: TaskParserService;
	let llm: MockLlmProvider;

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
	});

	it('add command attaches task to current chunk when one is active', async () => {
		seedPlanChunkRows([42]);
		const now = new Date();
		// Use the actual current wall clock so getCurrentChunk(chunks, new Date())
		// inside the helper picks our chunk; build a chunk that wraps "now".
		const startHh = `${String(now.getHours()).padStart(2, '0')}:00`;
		const endHh = `${String((now.getHours() + 1) % 24).padStart(2, '0')}:00`;
		const chunk = mkChunk(42, startHh, endHh, 'Day branch');
		const dailyPlanService = mkPlanService([chunk]);

		const result = await routeTextInput('add Buy milk', {
			taskService,
			parser,
			dailyPlanService,
		});
		expect(result.reply).toContain('Task created');

		const created = getCreatedTask('Buy milk');
		expect(created?.chunkId).toBe(42);
		expect(created?.branchName).toBe('Day branch');
	});

	it('add command leaves chunkId null when no chunk is active', async () => {
		// Empty plan: no chunks at all
		const dailyPlanService = mkEmptyPlanService();

		const result = await routeTextInput('add Buy bread', {
			taskService,
			parser,
			dailyPlanService,
		});
		expect(result.reply).toContain('Task created');

		const created = getCreatedTask('Buy bread');
		expect(created?.chunkId).toBeNull();
		expect(created?.branchName).toBeNull();
	});

	it('add! essential command applies the same fallback', async () => {
		seedPlanChunkRows([7]);
		const now = new Date();
		const startHh = `${String(now.getHours()).padStart(2, '0')}:00`;
		const endHh = `${String((now.getHours() + 1) % 24).padStart(2, '0')}:00`;
		const chunk = mkChunk(7, startHh, endHh, 'Morning duties');
		const dailyPlanService = mkPlanService([chunk]);

		const result = await routeTextInput('add! Workout', {
			taskService,
			parser,
			dailyPlanService,
		});
		expect(result.reply).toContain('Essential task created');

		const created = getCreatedTask('Workout');
		expect(created?.chunkId).toBe(7);
		expect(created?.branchName).toBe('Morning duties');
		expect(created?.isEssential).toBe(true);
	});

	it('NL parse fallback applies the D-16 fallback', async () => {
		seedPlanChunkRows([99]);
		const now = new Date();
		const startHh = `${String(now.getHours()).padStart(2, '0')}:00`;
		const endHh = `${String((now.getHours() + 1) % 24).padStart(2, '0')}:00`;
		const chunk = mkChunk(99, startHh, endHh, 'Day branch');
		const dailyPlanService = mkPlanService([chunk]);

		llm.setFixture('task_parse', {
			name: 'Call dentist',
			taskType: 'ad-hoc',
			isEssential: false,
		});

		const result = await routeTextInput('I need to call the dentist tomorrow', {
			taskService,
			parser,
			dailyPlanService,
		});
		expect(result.reply).toContain('Task created');

		const created = getCreatedTask('Call dentist');
		expect(created?.chunkId).toBe(99);
		expect(created?.branchName).toBe('Day branch');
	});

	it('missing dailyPlanService injects null attachment silently', async () => {
		const result = await routeTextInput('add Standalone task', {
			taskService,
			parser,
			// no dailyPlanService
		});
		expect(result.reply).toContain('Task created');

		const created = getCreatedTask('Standalone task');
		expect(created?.chunkId).toBeNull();
		expect(created?.branchName).toBeNull();
	});
});

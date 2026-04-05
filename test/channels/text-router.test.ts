import { describe, it, expect, beforeEach } from 'vitest';
import { routeTextInput, type TextRouterDeps } from '../../src/channels/telegram/handlers/text-router.js';
import { createTestDb } from '../helpers/db.js';
import { MockLlmProvider } from '../../src/providers/mock.js';
import { TaskService } from '../../src/core/task-service.js';
import { TaskParserService } from '../../src/core/task-parser.js';
import { DayTreeService } from '../../src/core/day-tree-service.js';
import { dayTrees } from '../../src/db/schema.js';

const SAMPLE_TREE = {
	cycles: [
		{ name: 'Wake up', startTime: '07:00', endTime: '08:00', isTaskSlot: false, items: [{ label: 'Wake up', type: 'fixed' as const }] },
		{ name: 'Morning duties', startTime: '08:00', endTime: '10:00', isTaskSlot: true },
		{ name: 'Day cycle', startTime: '10:00', endTime: '21:00', isTaskSlot: true, items: [{ label: 'Games allowed 16-21', type: 'rule' as const }] },
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

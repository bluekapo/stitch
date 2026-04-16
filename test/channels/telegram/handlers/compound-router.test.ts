import { describe, expect, it, vi } from 'vitest';
import { routeTextInput } from '../../../../src/channels/telegram/handlers/text-router.js';
import type { CheckInService } from '../../../../src/core/check-in-service.js';
import { DayTreeService } from '../../../../src/core/day-tree-service.js';
import { IntentClassifierService } from '../../../../src/core/intent-classifier.js';
import { TaskParserService } from '../../../../src/core/task-parser.js';
import { TaskService } from '../../../../src/core/task-service.js';
import { dayTrees, tasks } from '../../../../src/db/schema.js';
import { MockLlmProvider } from '../../../../src/providers/mock.js';
import { createTestDb } from '../../../helpers/db.js';
import { createTestLogger } from '../../../helpers/logger.js';

/**
 * Phase 13 Wave 0: RED integration tests for compound router dispatch.
 *
 * These tests INTENTIONALLY fail today because the compound branch does not
 * exist in ClassifierResponseSchema yet. Wave 2 (Plan 03) adds it to the
 * schema; Wave 3 (Plan 04) wires the router dispatch; these turn green then.
 *
 * Covers D-20 (compound branch), D-21 (sequential continue-on-error),
 * D-22 (JARVIS bulleted reply), D-24 (single forceCheckIn per compound).
 */

function makeTestDeps() {
	const db = createTestDb();
	const llm = new MockLlmProvider();
	const logger = createTestLogger();
	const taskService = new TaskService(db, logger);
	const parser = new TaskParserService(llm, logger);
	const dayTreeService = new DayTreeService(db, llm, logger);
	const intentClassifierService = new IntentClassifierService(
		llm,
		dayTreeService,
		taskService,
		logger,
	);

	// Seed a tree
	db.insert(dayTrees)
		.values({
			tree: {
				branches: [{ name: 'Day', startTime: '09:00', endTime: '21:00', isTaskSlot: true }],
			},
		})
		.run();

	// Create a task for modify tests
	const task = taskService.create(
		{ name: 'laundry', isEssential: false, taskType: 'ad-hoc' },
		logger,
	);

	const forceCheckInSpy = vi.fn().mockResolvedValue(undefined);
	const checkInService = {
		forceCheckIn: forceCheckInSpy,
	} as unknown as CheckInService;

	return {
		db,
		llm,
		taskService,
		parser,
		dayTreeService,
		intentClassifierService,
		checkInService,
		forceCheckInSpy,
		task,
		logger,
	};
}

describe('compound router dispatch (Phase 13)', () => {
	it('compound with [task_create, task_modify done] executes both, reply starts with "Handled, Sir:" and contains 2 bullets', async () => {
		const deps = makeTestDeps();

		// Classifier returns compound
		deps.llm.setFixture('intent_classifier', {
			intent: 'compound',
			confidence: 0.9,
			steps: [
				{
					intent: 'task_create',
					confidence: 0.95,
					suggested_chunk_id: null,
					suggested_branch_name: null,
					is_essential: false,
				},
				{
					intent: 'task_modify',
					confidence: 0.9,
					task_id: deps.task.id,
					action: 'done',
				},
			],
		});

		// Parser fixture for the task_create step
		deps.llm.setFixture('task_parser', {
			name: 'groceries',
			description: null,
			isEssential: false,
			taskType: 'ad-hoc',
			deadline: null,
			recurrenceDay: null,
		});

		const result = await routeTextInput('add groceries and mark laundry done', {
			taskService: deps.taskService,
			parser: deps.parser,
			dayTreeService: deps.dayTreeService,
			intentClassifierService: deps.intentClassifierService,
			checkInService: deps.checkInService,
			db: deps.db,
			logger: deps.logger,
		});

		expect(result.reply).toContain('Handled, Sir:');
		const bulletCount = (result.reply.match(/\u2022/g) || []).length;
		expect(bulletCount).toBe(2);
	});

	it('compound where step[0] throws still executes step[1] and yields a bullet with "Error:" prefix', async () => {
		const deps = makeTestDeps();

		deps.llm.setFixture('intent_classifier', {
			intent: 'compound',
			confidence: 0.9,
			steps: [
				{
					intent: 'task_modify',
					confidence: 0.9,
					task_id: 99999, // does not exist
					action: 'done',
				},
				{
					intent: 'task_create',
					confidence: 0.95,
					suggested_chunk_id: null,
					suggested_branch_name: null,
					is_essential: false,
				},
			],
		});

		deps.llm.setFixture('task_parser', {
			name: 'new-task',
			description: null,
			isEssential: false,
			taskType: 'ad-hoc',
			deadline: null,
			recurrenceDay: null,
		});

		const result = await routeTextInput('delete task 99999 and add new-task', {
			taskService: deps.taskService,
			parser: deps.parser,
			dayTreeService: deps.dayTreeService,
			intentClassifierService: deps.intentClassifierService,
			checkInService: deps.checkInService,
			db: deps.db,
			logger: deps.logger,
		});

		expect(result.reply).toContain('Error:');
		// Should still have created the task from step[1]
		const bulletCount = (result.reply.match(/\u2022/g) || []).length;
		expect(bulletCount).toBeGreaterThanOrEqual(2);
	});

	it('forceCheckIn is called EXACTLY once after compound with mutation steps', async () => {
		const deps = makeTestDeps();

		deps.llm.setFixture('intent_classifier', {
			intent: 'compound',
			confidence: 0.9,
			steps: [
				{
					intent: 'task_create',
					confidence: 0.95,
					suggested_chunk_id: null,
					suggested_branch_name: null,
					is_essential: false,
				},
				{
					intent: 'task_modify',
					confidence: 0.9,
					task_id: deps.task.id,
					action: 'done',
				},
			],
		});

		deps.llm.setFixture('task_parser', {
			name: 'groceries',
			description: null,
			isEssential: false,
			taskType: 'ad-hoc',
			deadline: null,
			recurrenceDay: null,
		});

		await routeTextInput('add groceries and mark laundry done', {
			taskService: deps.taskService,
			parser: deps.parser,
			dayTreeService: deps.dayTreeService,
			intentClassifierService: deps.intentClassifierService,
			checkInService: deps.checkInService,
			db: deps.db,
			logger: deps.logger,
		});

		// D-24: forceCheckIn called EXACTLY once, not per step
		expect(deps.forceCheckInSpy).toHaveBeenCalledTimes(1);
		expect(deps.forceCheckInSpy).toHaveBeenCalledWith('task_action');
	});

	it('compound with zero mutation steps (query-only) does NOT call forceCheckIn', async () => {
		const deps = makeTestDeps();

		deps.llm.setFixture('intent_classifier', {
			intent: 'compound',
			confidence: 0.9,
			steps: [
				{ intent: 'task_query', confidence: 0.9 },
				{ intent: 'plan_view', confidence: 0.9 },
			],
		});

		await routeTextInput('show my tasks and show my plan', {
			taskService: deps.taskService,
			parser: deps.parser,
			dayTreeService: deps.dayTreeService,
			intentClassifierService: deps.intentClassifierService,
			checkInService: deps.checkInService,
			db: deps.db,
			logger: deps.logger,
		});

		expect(deps.forceCheckInSpy).not.toHaveBeenCalled();
	});

	it('low-confidence (<0.7) compound hits existing clarification branch', async () => {
		const deps = makeTestDeps();

		deps.llm.setFixture('intent_classifier', {
			intent: 'compound',
			confidence: 0.5,
			clarification: 'Apologies, Sir. Could you break that down for me?',
			steps: [
				{
					intent: 'task_create',
					confidence: 0.95,
					suggested_chunk_id: null,
					suggested_branch_name: null,
					is_essential: false,
				},
				{ intent: 'task_query', confidence: 0.9 },
			],
		});

		const result = await routeTextInput('do something with stuff', {
			taskService: deps.taskService,
			parser: deps.parser,
			dayTreeService: deps.dayTreeService,
			intentClassifierService: deps.intentClassifierService,
			checkInService: deps.checkInService,
			db: deps.db,
			logger: deps.logger,
		});

		expect(result.reply).toContain('Could you');
		expect(deps.forceCheckInSpy).not.toHaveBeenCalled();
	});
});

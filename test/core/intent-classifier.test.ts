import { beforeEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { DailyPlanService } from '../../src/core/daily-plan-service.js';
import { DayTreeService } from '../../src/core/day-tree-service.js';
import {
	CONFIDENCE_THRESHOLD,
	IntentClassifierService,
} from '../../src/core/intent-classifier.js';
import { TaskService } from '../../src/core/task-service.js';
import type { ChatMessage, LlmCompletionOptions, LlmProvider } from '../../src/providers/llm.js';
import { MockLlmProvider } from '../../src/providers/mock.js';
import { dayTrees, tasks } from '../../src/db/schema.js';
import { createTestDb } from '../helpers/db.js';

const SAMPLE_TREE = {
	branches: [
		{
			name: 'Morning duties',
			startTime: '08:00',
			endTime: '10:00',
			isTaskSlot: true,
		},
		{
			name: 'Day branch',
			startTime: '10:00',
			endTime: '21:00',
			isTaskSlot: true,
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

function mkEmptyPlanService(): DailyPlanService {
	return {
		getTodayPlan: () => undefined,
		getPlanWithChunks: () => ({ chunks: [] }),
		// biome-ignore lint/suspicious/noExplicitAny: only the two methods are exercised
	} as any as DailyPlanService;
}

describe('IntentClassifierService', () => {
	let llm: MockLlmProvider;
	let classifier: IntentClassifierService;

	beforeEach(() => {
		const db = createTestDb();
		db.insert(dayTrees).values({ tree: SAMPLE_TREE }).run();
		db.insert(tasks).values({ name: 'Laundry', status: 'pending' }).run();
		db.insert(tasks).values({ name: 'Groceries', status: 'pending' }).run();

		llm = new MockLlmProvider();
		const dayTreeService = new DayTreeService(db, llm);
		const taskService = new TaskService(db);
		const dailyPlanService = mkEmptyPlanService();
		classifier = new IntentClassifierService(
			llm,
			dayTreeService,
			taskService,
			dailyPlanService,
		);
	});

	it('exports CONFIDENCE_THRESHOLD = 0.7 per D-22', () => {
		expect(CONFIDENCE_THRESHOLD).toBe(0.7);
	});

	it('canonical: classifies "add groceries" as task_create', async () => {
		llm.setFixture('intent_classifier', {
			intent: 'task_create',
			confidence: 0.95,
			suggested_chunk_id: null,
			suggested_branch_name: null,
			is_essential: false,
		});
		const result = await classifier.classify('add groceries');
		expect(result.intent).toBe('task_create');
		if (result.intent === 'task_create') {
			expect(result.confidence).toBeGreaterThanOrEqual(0.9);
			expect(result.is_essential).toBe(false);
		}
	});

	it('canonical: classifies "add a reading block from 15-16" as tree_edit', async () => {
		llm.setFixture('intent_classifier', {
			intent: 'tree_edit',
			confidence: 0.95,
			modification: 'add a reading block from 15:00 to 16:00',
		});
		const result = await classifier.classify('add a reading block from 15-16');
		expect(result.intent).toBe('tree_edit');
		if (result.intent === 'tree_edit') {
			expect(result.modification).toContain('reading block');
		}
	});

	it('canonical: classifies "move dinner to 20:00" as tree_edit', async () => {
		llm.setFixture('intent_classifier', {
			intent: 'tree_edit',
			confidence: 0.95,
			modification: 'move dinner to 20:00',
		});
		const result = await classifier.classify('move dinner to 20:00');
		expect(result.intent).toBe('tree_edit');
		if (result.intent === 'tree_edit') {
			expect(result.modification).toContain('dinner');
			expect(result.modification).toContain('20:00');
		}
	});

	it('canonical: classifies "Change dinner to 20:00" as tree_edit (Phase 08.4 fix)', async () => {
		llm.setFixture('intent_classifier', {
			intent: 'tree_edit',
			confidence: 0.95,
			modification: 'move dinner to 20:00',
		});
		const result = await classifier.classify('Change dinner to 20:00');
		expect(result.intent).toBe('tree_edit');
		if (result.intent === 'tree_edit') {
			expect(result.modification).toContain('dinner');
			expect(result.modification).toContain('20:00');
		}
	});

	it('classifies "I finished laundry" as task_modify action=done', async () => {
		llm.setFixture('intent_classifier', {
			intent: 'task_modify',
			confidence: 0.9,
			task_id: 1,
			action: 'done',
		});
		const result = await classifier.classify('I finished laundry');
		expect(result.intent).toBe('task_modify');
		if (result.intent === 'task_modify') {
			expect(result.action).toBe('done');
			expect(result.task_id).toBe(1);
		}
	});

	it('classifies "what\'s my plan today" as plan_view', async () => {
		llm.setFixture('intent_classifier', {
			intent: 'plan_view',
			confidence: 0.95,
		});
		const result = await classifier.classify("what's my plan today");
		expect(result.intent).toBe('plan_view');
	});

	it('classifies "regenerate my plan" as plan_regenerate target_date=today', async () => {
		llm.setFixture('intent_classifier', {
			intent: 'plan_regenerate',
			confidence: 0.95,
			target_date: 'today',
		});
		const result = await classifier.classify('regenerate my plan');
		expect(result.intent).toBe('plan_regenerate');
		if (result.intent === 'plan_regenerate') {
			expect(result.target_date).toBe('today');
		}
	});

	it('classifies "regenerate my plan tomorrow" as plan_regenerate target_date=tomorrow', async () => {
		llm.setFixture('intent_classifier', {
			intent: 'plan_regenerate',
			confidence: 0.92,
			target_date: 'tomorrow',
		});
		const result = await classifier.classify('regenerate my plan tomorrow');
		expect(result.intent).toBe('plan_regenerate');
		if (result.intent === 'plan_regenerate') {
			expect(result.target_date).toBe('tomorrow');
		}
	});

	it('classifies "show me my day tree" as tree_query', async () => {
		llm.setFixture('intent_classifier', {
			intent: 'tree_query',
			confidence: 0.95,
		});
		const result = await classifier.classify('show me my day tree');
		expect(result.intent).toBe('tree_query');
	});

	it('classifies "add dinner task" as task_create despite "dinner" being a tree branch (D-15 explicit-token rule)', async () => {
		llm.setFixture('intent_classifier', {
			intent: 'task_create',
			confidence: 0.9,
			suggested_chunk_id: null,
			suggested_branch_name: null,
			is_essential: false,
		});
		const result = await classifier.classify('add dinner task');
		expect(result.intent).toBe('task_create');
	});

	it('classifies "asdfjkl;" as unknown with low confidence', async () => {
		llm.setFixture('intent_classifier', {
			intent: 'unknown',
			confidence: 0.2,
			clarification: 'Apologies, Sir. I did not catch that.',
		});
		const result = await classifier.classify('asdfjkl;');
		expect(result.intent).toBe('unknown');
		if (result.intent === 'unknown') {
			expect(result.confidence).toBeLessThan(CONFIDENCE_THRESHOLD);
			expect(result.clarification).toBeDefined();
		}
	});

	it('throws when MockLlmProvider has no fixture for intent_classifier schemaName', async () => {
		await expect(classifier.classify('anything')).rejects.toThrow(
			'No mock fixture registered',
		);
	});

	it('builds user prompt with day tree JSON, pending tasks, current chunk summary, current time HH:MM, weekday', async () => {
		// Capture the messages passed to the mock provider.
		let captured: ChatMessage[] = [];
		const capturingLlm: LlmProvider = {
			async complete<T extends z.ZodType>(
				options: LlmCompletionOptions<T>,
			): Promise<z.infer<T>> {
				captured = options.messages;
				const fixture = {
					intent: 'task_query',
					confidence: 0.95,
				};
				return options.schema.parse(fixture) as z.infer<T>;
			},
			async healthCheck() {
				return { ok: true };
			},
		};

		const db = createTestDb();
		db.insert(dayTrees).values({ tree: SAMPLE_TREE }).run();
		db.insert(tasks).values({ name: 'Laundry', status: 'pending' }).run();
		db.insert(tasks).values({ name: 'Groceries', status: 'pending' }).run();
		const dayTreeService = new DayTreeService(db, capturingLlm);
		const taskService = new TaskService(db);
		const dailyPlanService = mkEmptyPlanService();
		const capturingClassifier = new IntentClassifierService(
			capturingLlm,
			dayTreeService,
			taskService,
			dailyPlanService,
		);

		await capturingClassifier.classify('list my tasks');

		const userMsg = captured.find((m) => m.role === 'user');
		expect(userMsg).toBeDefined();
		expect(userMsg?.content).toContain('Day tree:');
		expect(userMsg?.content).toContain('Pending tasks:');
		expect(userMsg?.content).toContain('Laundry');
		expect(userMsg?.content).toContain('Groceries');
		expect(userMsg?.content).toContain('Current chunk:');
		expect(userMsg?.content).toContain('Current time:');
		expect(userMsg?.content).toMatch(/weekday: (Sun|Mon|Tue|Wed|Thu|Fri|Sat)/);
		expect(userMsg?.content).toContain('User message: list my tasks');
	});

	it('calls llmProvider.complete with temperature: 0.3, thinking: false, schemaName: intent_classifier', async () => {
		let capturedOptions: LlmCompletionOptions<z.ZodType> | null = null;
		const capturingLlm: LlmProvider = {
			async complete<T extends z.ZodType>(
				options: LlmCompletionOptions<T>,
			): Promise<z.infer<T>> {
				capturedOptions = options as unknown as LlmCompletionOptions<z.ZodType>;
				return options.schema.parse({
					intent: 'task_query',
					confidence: 0.95,
				}) as z.infer<T>;
			},
			async healthCheck() {
				return { ok: true };
			},
		};

		const db = createTestDb();
		db.insert(dayTrees).values({ tree: SAMPLE_TREE }).run();
		const dayTreeService = new DayTreeService(db, capturingLlm);
		const taskService = new TaskService(db);
		const dailyPlanService = mkEmptyPlanService();
		const capturingClassifier = new IntentClassifierService(
			capturingLlm,
			dayTreeService,
			taskService,
			dailyPlanService,
		);

		await capturingClassifier.classify('list my tasks');

		expect(capturedOptions).not.toBeNull();
		const opts = capturedOptions as unknown as LlmCompletionOptions<z.ZodType>;
		expect(opts.temperature).toBe(0.3);
		expect(opts.thinking).toBe(false);
		expect(opts.schemaName).toBe('intent_classifier');
	});
});

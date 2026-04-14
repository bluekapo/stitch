import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { DayTreeService } from '../../src/core/day-tree-service.js';
import { PredictionService } from '../../src/core/prediction-service.js';
import { TaskService } from '../../src/core/task-service.js';
import type { StitchDb } from '../../src/db/index.js';
import { taskDurations } from '../../src/db/schema.js';
import type { ChatMessage, LlmCompletionOptions, LlmProvider } from '../../src/providers/llm.js';
import { MockLlmProvider } from '../../src/providers/mock.js';
import { createTestDb } from '../helpers/db.js';

/**
 * Recording mock that captures the messages and call count for the
 * 'prediction' schema name. Built inline (not extending MockLlmProvider)
 * because the global mock has neither setError nor getCalls — and the
 * canonical pattern in this repo (intent-classifier.test.ts:222-243) is
 * to spin up an inline LlmProvider per-test.
 */
class RecordingPredictionLlm implements LlmProvider {
	private fixture: unknown = null;
	private error: Error | null = null;
	public calls: Array<{ messages: ChatMessage[] }> = [];

	setFixture(data: unknown): void {
		this.fixture = data;
		this.error = null;
	}

	setError(err: Error): void {
		this.error = err;
		this.fixture = null;
	}

	get callCount(): number {
		return this.calls.length;
	}

	async complete<T extends z.ZodType>(options: LlmCompletionOptions<T>): Promise<z.infer<T>> {
		// Record before throwing so retry-call captures show up too.
		this.calls.push({ messages: options.messages });

		if (this.error) {
			throw this.error;
		}
		if (this.fixture == null) {
			throw new Error(`No fixture set for RecordingPredictionLlm (schema=${options.schemaName})`);
		}

		const result = options.schema.safeParse(this.fixture);
		if (!result.success) {
			throw new Error(
				`Recording mock fixture failed Zod validation: ${JSON.stringify(result.error.issues)}`,
			);
		}
		return result.data;
	}

	async healthCheck(): Promise<{ ok: boolean; error?: string }> {
		return { ok: true };
	}
}

describe('PredictionService', () => {
	let db: StitchDb;
	let taskService: TaskService;
	let dayTreeService: DayTreeService;
	let llm: RecordingPredictionLlm;
	let baselineLlm: MockLlmProvider; // for DayTreeService — never invoked in these tests
	let service: PredictionService;

	beforeEach(() => {
		db = createTestDb();
		baselineLlm = new MockLlmProvider();
		llm = new RecordingPredictionLlm();
		taskService = new TaskService(db);
		dayTreeService = new DayTreeService(db, baselineLlm);
		service = new PredictionService(db, taskService, dayTreeService, llm);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function seedTaskDuration(
		taskId: number,
		seconds: number | null,
		outcome: 'completed' | 'skipped' | 'postponed' = 'completed',
		startedAt?: string,
	) {
		db.insert(taskDurations)
			.values({
				taskId,
				durationSeconds: outcome === 'completed' ? seconds : null,
				outcome,
				startedAt: startedAt ?? new Date().toISOString(),
			})
			.run();
	}

	it('returns predictions for pending tasks', async () => {
		const t1 = taskService.create({ name: 'Task A' });
		const t2 = taskService.create({ name: 'Task B' });

		llm.setFixture({
			predictions: [
				{
					reasoning:
						'A: 3 rows, tight cluster. Based on 3 rows and observed drift, classifying as high.',
					taskId: t1.id,
					predicted_min_seconds: 600,
					predicted_max_seconds: 900,
					confidence: 'high',
				},
				{
					reasoning: 'B: no history. Based on 0 rows and no drift signal, classifying as low.',
					taskId: t2.id,
					predicted_min_seconds: 300,
					predicted_max_seconds: 1500,
					confidence: 'low',
				},
			],
		});

		const result = await service.predictDurations([
			{ id: t1.id, name: 'Task A', sourceTaskId: null },
			{ id: t2.id, name: 'Task B', sourceTaskId: null },
		]);

		expect(result.size).toBe(2);
		expect(result.get(t1.id)?.confidence).toBe('high');
		expect(result.get(t2.id)?.confidence).toBe('low');
		expect(result.get(t1.id)?.predicted_max_seconds).toBe(900);
	});

	it('drops hallucinated taskIds', async () => {
		const t1 = taskService.create({ name: 'Task A' });

		llm.setFixture({
			predictions: [
				{
					reasoning: 'A: real task. Based on 0 rows and no drift, classifying as low.',
					taskId: t1.id,
					predicted_min_seconds: 300,
					predicted_max_seconds: 900,
					confidence: 'low',
				},
				{
					reasoning: 'hallucinated: Based on 0 rows, classifying as low.',
					taskId: 999,
					predicted_min_seconds: 100,
					predicted_max_seconds: 200,
					confidence: 'low',
				},
			],
		});

		const result = await service.predictDurations([
			{ id: t1.id, name: 'Task A', sourceTaskId: null },
		]);

		expect(result.size).toBe(1);
		expect(result.has(t1.id)).toBe(true);
		expect(result.has(999)).toBe(false);
	});

	it('retries once then falls through with empty Map on second failure (D-06)', async () => {
		const t1 = taskService.create({ name: 'Task A' });

		llm.setError(new Error('llama-server 500'));

		const result = await service.predictDurations([
			{ id: t1.id, name: 'Task A', sourceTaskId: null },
		]);

		expect(result.size).toBe(0);
		// Asserts the mock was invoked twice: first attempt + one retry (D-06).
		expect(llm.callCount).toBe(2);
	});

	it('walks sourceTaskId chain for recurring task instances (D-13)', async () => {
		const template = taskService.create({ name: 'Morning standup', taskType: 'daily' });
		const inst1 = taskService.createInstance(
			{ id: template.id, name: template.name, description: null, isEssential: false },
			'2026-04-05',
		);
		const inst2 = taskService.createInstance(
			{ id: template.id, name: template.name, description: null, isEssential: false },
			'2026-04-06',
		);
		const inst3 = taskService.createInstance(
			{ id: template.id, name: template.name, description: null, isEssential: false },
			'2026-04-07',
		);

		// Historical rows against 2 of the 3 instances. Use today's timestamp so
		// they ALSO show up in the 7-day global activity (the test doesn't care
		// about that, but it's the realistic scenario).
		seedTaskDuration(inst1.id, 900); // 15 min
		seedTaskDuration(inst2.id, 1080); // 18 min

		llm.setFixture({
			predictions: [
				{
					reasoning: 'stub',
					taskId: inst3.id,
					predicted_min_seconds: 900,
					predicted_max_seconds: 1200,
					confidence: 'high',
				},
			],
		});

		await service.predictDurations([
			{ id: inst3.id, name: 'Morning standup', sourceTaskId: template.id },
		]);

		// Inspect the user prompt that was passed to the LLM: both actuals should be there.
		expect(llm.calls.length).toBeGreaterThanOrEqual(1);
		const userMsg = llm.calls[0].messages.find((m) => m.role === 'user');
		expect(userMsg).toBeDefined();
		// Raw minutes from the two seeded rows should appear in the per-task block.
		expect(userMsg?.content).toContain('15 min');
		expect(userMsg?.content).toContain('18 min');
	});

	it('prompt contains raw rows not aggregates (D-09)', async () => {
		const t1 = taskService.create({ name: 'Write report' });
		seedTaskDuration(t1.id, 1500); // 25 min
		seedTaskDuration(t1.id, 1800); // 30 min
		seedTaskDuration(t1.id, 2100); // 35 min

		llm.setFixture({
			predictions: [
				{
					reasoning: 'stub',
					taskId: t1.id,
					predicted_min_seconds: 1500,
					predicted_max_seconds: 2100,
					confidence: 'medium',
				},
			],
		});

		await service.predictDurations([{ id: t1.id, name: 'Write report', sourceTaskId: null }]);

		const userMsg = llm.calls[0].messages.find((m) => m.role === 'user');
		expect(userMsg?.content).toContain('25 min');
		expect(userMsg?.content).toContain('30 min');
		expect(userMsg?.content).toContain('35 min');
		// Raw rows only — no aggregation strings emitted by the formatter
		expect(userMsg?.content).not.toMatch(/average/i);
		expect(userMsg?.content).not.toMatch(/median/i);
		// Whole-word "mean" only (avoids matching "meaningful" etc.)
		expect(userMsg?.content).not.toMatch(/\bmean\b/i);
	});

	it('global activity includes skipped and postponed events (D-12)', async () => {
		const t1 = taskService.create({ name: 'Task A' });
		const t2 = taskService.create({ name: 'Task B' });
		const t3 = taskService.create({ name: 'Task C' });

		seedTaskDuration(t1.id, 900, 'completed');
		seedTaskDuration(t2.id, null, 'skipped');
		seedTaskDuration(t3.id, null, 'postponed');

		llm.setFixture({
			predictions: [
				{
					reasoning: 'stub',
					taskId: t1.id,
					predicted_min_seconds: 600,
					predicted_max_seconds: 1200,
					confidence: 'low',
				},
			],
		});

		await service.predictDurations([{ id: t1.id, name: 'Task A', sourceTaskId: null }]);

		const userMsg = llm.calls[0].messages.find((m) => m.role === 'user');
		expect(userMsg?.content).toContain('COMPLETED');
		expect(userMsg?.content).toContain('SKIPPED');
		expect(userMsg?.content).toContain('POSTPONED');
	});
});

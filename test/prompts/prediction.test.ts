import { describe, expect, it } from 'vitest';
import {
	buildPredictionUserPrompt,
	type GlobalActivityRow,
	PREDICTION_SYSTEM_PROMPT,
	type TaskDurationRow,
} from '../../src/prompts/prediction.js';

describe('PREDICTION_SYSTEM_PROMPT', () => {
	it('contains the anti-averaging directive (D-09 forcing function)', () => {
		expect(PREDICTION_SYSTEM_PROMPT).toContain('Do NOT just average');
	});

	it('contains confidence row-count anchors', () => {
		expect(PREDICTION_SYSTEM_PROMPT).toContain('5+');
		expect(PREDICTION_SYSTEM_PROMPT).toContain('<3');
	});

	it('contains two embedded few-shot examples', () => {
		expect(PREDICTION_SYSTEM_PROMPT).toContain('Example 1');
		expect(PREDICTION_SYSTEM_PROMPT).toContain('Example 2');
	});

	it('does not import or call withSoul (wrapping happens in PredictionService)', () => {
		// Sentinel: if anyone adds a withSoul() call to this module, the
		// service will double-wrap. This test enforces the convention.
		expect(PREDICTION_SYSTEM_PROMPT).not.toContain('You are JARVIS');
	});
});

describe('buildPredictionUserPrompt', () => {
	const now = new Date('2026-04-07T10:00:00Z');

	it('emits raw rows chronologically with task name anchored at top', () => {
		const perTaskHistory = new Map<number, TaskDurationRow[]>([
			[
				1,
				[
					{
						id: 1,
						taskId: 1,
						durationSeconds: 1500, // 25 min
						outcome: 'completed',
						predictedMinSeconds: 600,
						predictedMaxSeconds: 1200,
						predictedConfidence: 'medium',
						startedAt: '2026-04-05T08:00:00Z',
					},
					{
						id: 2,
						taskId: 1,
						durationSeconds: 1800, // 30 min
						outcome: 'completed',
						predictedMinSeconds: 600,
						predictedMaxSeconds: 1200,
						predictedConfidence: 'medium',
						startedAt: '2026-04-06T08:00:00Z',
					},
				],
			],
		]);

		const result = buildPredictionUserPrompt({
			pendingTasks: [{ id: 1, name: 'Write report', sourceTaskId: null }],
			perTaskHistory,
			globalActivity: [],
			tree: null,
			now,
		});

		expect(result).toContain('Task "Write report" (id=1)');
		expect(result).toContain('25 min');
		expect(result).toContain('30 min');
		expect(result).toContain('COMPLETED');
		// D-09 guardrail: no aggregation strings emitted by the formatter
		expect(result).not.toMatch(/average/i);
		expect(result).not.toMatch(/median/i);
		expect(result).not.toMatch(/\bmean\b/i);
	});

	it('emits cold-start placeholder when no history exists', () => {
		const result = buildPredictionUserPrompt({
			pendingTasks: [{ id: 5, name: 'New task', sourceTaskId: null }],
			perTaskHistory: new Map(),
			globalActivity: [],
			tree: null,
			now,
		});
		expect(result).toContain('Task "New task" (id=5)');
		expect(result).toContain('cold start');
	});

	it('global activity block includes skipped and postponed outcomes (D-12)', () => {
		const globalActivity: GlobalActivityRow[] = [
			{
				id: 10,
				taskId: 1,
				taskName: 'Task A',
				durationSeconds: 900,
				outcome: 'completed',
				predictedMinSeconds: null,
				predictedMaxSeconds: null,
				predictedConfidence: null,
				startedAt: '2026-04-06T08:00:00Z',
			},
			{
				id: 11,
				taskId: 2,
				taskName: 'Task B',
				durationSeconds: null,
				outcome: 'skipped',
				predictedMinSeconds: null,
				predictedMaxSeconds: null,
				predictedConfidence: null,
				startedAt: '2026-04-06T09:00:00Z',
			},
			{
				id: 12,
				taskId: 3,
				taskName: 'Task C',
				durationSeconds: null,
				outcome: 'postponed',
				predictedMinSeconds: null,
				predictedMaxSeconds: null,
				predictedConfidence: null,
				startedAt: '2026-04-06T10:00:00Z',
			},
		];

		const result = buildPredictionUserPrompt({
			pendingTasks: [{ id: 99, name: 'Pending', sourceTaskId: null }],
			perTaskHistory: new Map(),
			globalActivity,
			tree: null,
			now,
		});

		expect(result).toContain('COMPLETED');
		expect(result).toContain('SKIPPED');
		expect(result).toContain('POSTPONED');
		expect(result).toContain('Task A');
		expect(result).toContain('Task B');
		expect(result).toContain('Task C');
	});
});

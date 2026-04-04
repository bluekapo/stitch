import { describe, expect, it } from 'vitest';
import { MockLlmProvider } from '../../src/providers/mock.js';
import {
	TaskAnalysisSchema,
	toResponseFormat,
} from '../../src/schemas/llm.js';

const validFixture = {
	taskName: 'Write unit tests',
	estimatedMinutes: 30,
	category: 'work' as const,
	subtasks: ['Setup test framework', 'Write test cases'],
};

describe('MockLlmProvider', () => {
	it('healthCheck() returns { ok: true }', async () => {
		const provider = new MockLlmProvider();
		const health = await provider.healthCheck();
		expect(health).toEqual({ ok: true });
	});

	it('complete() returns Zod-parsed data when fixture is valid', async () => {
		const provider = new MockLlmProvider();
		provider.setFixture('task-analysis', validFixture);

		const result = await provider.complete({
			messages: [{ role: 'user', content: 'Analyze task' }],
			schema: TaskAnalysisSchema,
			schemaName: 'task-analysis',
		});

		expect(result).toEqual(validFixture);
	});

	it('complete() throws when no fixture is registered for schema name', async () => {
		const provider = new MockLlmProvider();

		await expect(
			provider.complete({
				messages: [{ role: 'user', content: 'Analyze task' }],
				schema: TaskAnalysisSchema,
				schemaName: 'unknown-schema',
			}),
		).rejects.toThrow('No mock fixture registered for schema: unknown-schema');
	});

	it('complete() throws when fixture fails Zod validation', async () => {
		const provider = new MockLlmProvider();
		provider.setFixture('task-analysis', {
			taskName: 'Invalid',
			estimatedMinutes: 'not-a-number', // wrong type
			category: 'invalid-category', // not in enum
			subtasks: 'not-an-array', // wrong type
		});

		await expect(
			provider.complete({
				messages: [{ role: 'user', content: 'Analyze task' }],
				schema: TaskAnalysisSchema,
				schemaName: 'task-analysis',
			}),
		).rejects.toThrow('Mock fixture failed Zod validation for "task-analysis"');
	});
});

describe('toResponseFormat', () => {
	it('produces a valid JSON Schema response_format object', () => {
		const format = toResponseFormat(TaskAnalysisSchema, 'task-analysis');

		expect(format.type).toBe('json_schema');
		expect(format.json_schema.name).toBe('task-analysis');
		expect(format.json_schema.strict).toBe(true);
		expect(format.json_schema.schema).toHaveProperty('type', 'object');
		expect(format.json_schema.schema).toHaveProperty('properties');

		const props = format.json_schema.schema.properties as Record<
			string,
			unknown
		>;
		expect(props).toHaveProperty('taskName');
		expect(props).toHaveProperty('estimatedMinutes');
		expect(props).toHaveProperty('category');
		expect(props).toHaveProperty('subtasks');
	});
});

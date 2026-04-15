import { beforeEach, describe, expect, it } from 'vitest';
import { TaskParserService } from '../../src/core/task-parser.js';
import { MockLlmProvider } from '../../src/providers/mock.js';
import { createTestLogger } from '../helpers/logger.js';

describe('TaskParserService', () => {
	let llm: MockLlmProvider;
	let parser: TaskParserService;

	beforeEach(() => {
		llm = new MockLlmProvider();
		parser = new TaskParserService(llm, createTestLogger());
	});

	it('parses "buy groceries tomorrow by 5pm" as one-time with deadline', async () => {
		llm.setFixture('task_parse', {
			name: 'Buy groceries',
			taskType: 'one-time',
			deadline: '2026-04-06T17:00:00.000Z',
			isEssential: false,
		});
		const result = await parser.parse('buy groceries tomorrow by 5pm');
		expect(result.name).toContain('groceries');
		expect(result.taskType).toBe('one-time');
		expect(result.deadline).toBeDefined();
	});

	it('parses "morning workout every day" as daily', async () => {
		llm.setFixture('task_parse', {
			name: 'Morning workout',
			taskType: 'daily',
			isEssential: false,
		});
		const result = await parser.parse('morning workout every day');
		expect(result.name).toContain('workout');
		expect(result.taskType).toBe('daily');
	});

	it('parses "team meeting every Monday" as weekly with recurrenceDay=1', async () => {
		llm.setFixture('task_parse', {
			name: 'Team meeting',
			taskType: 'weekly',
			recurrenceDay: 1,
			isEssential: false,
		});
		const result = await parser.parse('team meeting every Monday');
		expect(result.name).toContain('meeting');
		expect(result.taskType).toBe('weekly');
		expect(result.recurrenceDay).toBe(1);
	});

	it('parses "fix the bug" as ad-hoc', async () => {
		llm.setFixture('task_parse', {
			name: 'Fix bug',
			taskType: 'ad-hoc',
			isEssential: false,
		});
		const result = await parser.parse('fix the bug');
		expect(result.name).toContain('bug');
		expect(result.taskType).toBe('ad-hoc');
	});

	it('parses "MUST DO taxes by April 15" with isEssential=true', async () => {
		llm.setFixture('task_parse', {
			name: 'File taxes',
			taskType: 'one-time',
			deadline: '2026-04-15T23:59:00.000Z',
			isEssential: true,
		});
		const result = await parser.parse('MUST DO taxes by April 15');
		expect(result.isEssential).toBe(true);
	});

	it('throws error when LLM has no fixture (simulates LLM failure)', async () => {
		// No fixture set -- MockLlmProvider throws "No mock fixture registered"
		await expect(parser.parse('anything')).rejects.toThrow('No mock fixture registered');
	});
});

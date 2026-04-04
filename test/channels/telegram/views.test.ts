import { describe, expect, it } from 'vitest';
import {
	escapeHtml,
	formatDuration,
	formatTime,
	formatDateTime,
	renderTasksView,
	renderTaskDetailView,
	renderTaskListText,
	renderHubView,
} from '../../../src/channels/telegram/views.js';
import type { TaskListItem, TaskDetail } from '../../../src/types/task.js';

describe('escapeHtml', () => {
	it('escapes < > & characters', () => {
		expect(escapeHtml('a<b>&c')).toBe('a&lt;b&gt;&amp;c');
	});

	it('returns plain text unchanged', () => {
		expect(escapeHtml('hello world')).toBe('hello world');
	});

	it('escapes script tags to prevent XSS', () => {
		expect(escapeHtml('<script>alert("xss")</script>')).toBe(
			'&lt;script&gt;alert("xss")&lt;/script&gt;',
		);
	});
});

describe('formatDuration', () => {
	it('formats 0 seconds as 00:00:00', () => {
		expect(formatDuration(0)).toBe('00:00:00');
	});

	it('formats 3661 seconds as 01:01:01', () => {
		expect(formatDuration(3661)).toBe('01:01:01');
	});

	it('formats 45296 seconds as 12:34:56', () => {
		expect(formatDuration(45296)).toBe('12:34:56');
	});
});

describe('formatTime', () => {
	it('extracts HH:MM from ISO string', () => {
		expect(formatTime('2026-04-04T14:30:00.000Z')).toBe('14:30');
	});
});

describe('formatDateTime', () => {
	it('formats ISO string as YYYY-MM-DD HH:MM', () => {
		expect(formatDateTime('2026-04-04T10:30:00.000Z')).toBe('2026-04-04 10:30');
	});
});

describe('renderTasksView', () => {
	it('returns empty state with "No tasks yet." and hint when no tasks', () => {
		const result = renderTasksView([]);
		expect(result).toContain('No tasks yet.');
		expect(result).toContain('Send "add Task name" to create one.');
	});

	it('returns header "-- Tasks --" and "Your tasks:" with tasks', () => {
		const tasks: TaskListItem[] = [
			{ id: 1, name: 'Buy groceries', status: 'pending', isEssential: false, timerStartedAt: null },
		];
		const result = renderTasksView(tasks);
		expect(result).toContain('-- Tasks --');
		expect(result).toContain('Your tasks:');
	});
});

describe('renderTaskDetailView', () => {
	const baseTask: TaskDetail = {
		id: 1,
		name: 'Buy groceries',
		description: null,
		status: 'pending',
		isEssential: false,
		postponeCount: 0,
		timerStartedAt: null,
		createdAt: '2026-04-04T10:30:00.000Z',
		totalDurationSeconds: null,
	};

	it('contains name and status for regular task', () => {
		const result = renderTaskDetailView(baseTask);
		expect(result).toContain('Buy groceries');
		expect(result).toContain('pending');
		expect(result).toContain('Task #1');
	});

	it('contains lock emoji and locked hint for essential task', () => {
		const result = renderTaskDetailView({ ...baseTask, isEssential: true });
		expect(result).toContain('\uD83D\uDD12');
		expect(result).toContain('locked and cannot be modified');
	});

	it('contains "Timer running since" with time when timer active', () => {
		const result = renderTaskDetailView({
			...baseTask,
			status: 'active',
			timerStartedAt: '2026-04-04T14:30:00.000Z',
		});
		expect(result).toContain('Timer running since');
		expect(result).toContain('14:30');
	});

	it('contains "Postponed" when postponements exist', () => {
		const result = renderTaskDetailView({ ...baseTask, postponeCount: 3 });
		expect(result).toContain('Postponed 3 times');
	});

	it('contains "Total time:" when totalDurationSeconds is set', () => {
		const result = renderTaskDetailView({
			...baseTask,
			status: 'completed',
			totalDurationSeconds: 6320,
		});
		expect(result).toContain('Total time:');
		expect(result).toContain('01:45:20');
	});

	it('escapes HTML in task names', () => {
		const result = renderTaskDetailView({ ...baseTask, name: '<script>evil</script>' });
		expect(result).toContain('&lt;script&gt;evil&lt;/script&gt;');
		expect(result).not.toContain('<script>');
	});
});

describe('renderTaskListText', () => {
	it('returns "No tasks" message when empty', () => {
		const result = renderTaskListText([]);
		expect(result).toBe('No tasks. Send "add Task name" to create one.');
	});

	it('returns numbered list with correct emoji prefixes', () => {
		const tasks: TaskListItem[] = [
			{ id: 1, name: 'Pending task', status: 'pending', isEssential: false, timerStartedAt: null },
			{ id: 2, name: 'Active task', status: 'active', isEssential: false, timerStartedAt: '2026-04-04T14:30:00.000Z' },
			{ id: 3, name: 'Done task', status: 'completed', isEssential: false, timerStartedAt: null },
			{ id: 4, name: 'Skipped task', status: 'skipped', isEssential: false, timerStartedAt: null },
			{ id: 5, name: 'Locked task', status: 'pending', isEssential: true, timerStartedAt: null },
		];
		const result = renderTaskListText(tasks);
		expect(result).toContain('1. Pending task (pending)');
		expect(result).toContain('2. \u25B6 Active task (active)');
		expect(result).toContain('3. \u2705 Done task (completed)');
		expect(result).toContain('4. \u23ED Skipped task (skipped)');
		expect(result).toContain('5. \uD83D\uDD12 Locked task (pending)');
	});
});

describe('renderHubView with timer', () => {
	it('shows task name on timer line when timer active', () => {
		const result = renderHubView({
			status: 'running',
			currentChunk: null,
			timer: 'Write report',
			timerSince: '14:30',
		});
		expect(result).toContain('Write report');
		expect(result).toContain('Running');
		expect(result).toContain('Timer running since 14:30.');
	});

	it('shows idle state with no timer', () => {
		const result = renderHubView({
			status: 'idle',
			currentChunk: null,
			timer: null,
			timerSince: null,
		});
		expect(result).toContain('Idle');
		expect(result).toContain('--:--:--');
		expect(result).toContain('Ready when you are.');
	});
});

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
	renderDayPlanView,
	renderCurrentChunkView,
	renderCurrentChunkTasksView,
} from '../../../src/channels/telegram/views.js';
import type { TaskListItem, TaskDetail } from '../../../src/types/task.js';
import type {
	CurrentChunkTasksView,
	CurrentChunkView,
	DailyPlanView,
} from '../../../src/types/daily-plan.js';

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

describe('renderDayPlanView', () => {
	const planView: DailyPlanView = {
		date: '2026-04-05',
		chunks: [
			{ label: 'Shower', startTime: '07:00', endTime: '07:30', isTaskSlot: false, status: 'completed', tasks: [] },
			{ label: 'Buy groceries', startTime: '07:30', endTime: '08:00', isTaskSlot: true, status: 'pending', tasks: [
				{ label: 'Buy groceries', isLocked: true, status: 'pending' },
			] },
		],
	};

	it('returns "No plan for today yet." when undefined', () => {
		const result = renderDayPlanView(undefined);
		expect(result).toContain('No plan for today yet.');
	});

	it('returns "Set a day tree" hint when undefined', () => {
		const result = renderDayPlanView(undefined);
		expect(result).toContain('Set a day tree');
	});

	it('renders both chunk labels when plan has 2 chunks', () => {
		const result = renderDayPlanView(planView);
		expect(result).toContain('Shower');
		expect(result).toContain('Buy groceries');
	});

	it('renders lock icon for locked task in chunk', () => {
		const result = renderDayPlanView(planView);
		expect(result).toContain('\uD83D\uDD12');
	});

	it('renders chunk start-end time range in HH:MM-HH:MM format', () => {
		const result = renderDayPlanView(planView);
		expect(result).toContain('07:00-07:30');
		expect(result).toContain('07:30-08:00');
	});

	it('renders checkmark icon for completed chunk', () => {
		const result = renderDayPlanView(planView);
		expect(result).toContain('\u2705');
	});

	it('includes the plan date in the header', () => {
		const result = renderDayPlanView(planView);
		expect(result).toContain('2026-04-05');
	});

	it('default mode (no arg) renders "-- Full Day Plan ({date}) --" title', () => {
		const result = renderDayPlanView(planView);
		expect(result).toContain('-- Full Day Plan (2026-04-05) --');
	});

	it('mode="full" renders "-- Full Day Plan ({date}) --" title', () => {
		const result = renderDayPlanView(planView, 'full');
		expect(result).toContain('-- Full Day Plan (2026-04-05) --');
	});

	it('mode="focused" renders "-- Day Plan ({date}) --" title (legacy)', () => {
		const result = renderDayPlanView(planView, 'focused');
		expect(result).toContain('-- Day Plan (2026-04-05) --');
		expect(result).not.toContain('Full Day Plan');
	});

	it('renderDayPlanView() with no args still returns "No plan" fallback (backward compat)', () => {
		const result = renderDayPlanView();
		expect(result).toContain('No plan for today yet.');
	});
});

describe('renderCurrentChunkView', () => {
	const baseView: CurrentChunkView = {
		date: '2026-04-06',
		branchName: 'Day cycle',
		chunk: {
			label: 'Deep work',
			startTime: '10:00',
			endTime: '12:00',
			tasks: [
				{ label: 'Write report', status: 'active', isLocked: false },
				{ label: 'Review PR', status: 'pending', isLocked: true },
				{ label: 'Reply to email', status: 'completed', isLocked: false },
				{ label: 'Cancelled meeting', status: 'skipped', isLocked: false },
			],
		},
		nextChunkStartTime: null,
	};

	it('Case A: renders title, branch line, chunk line, and task list when chunk has tasks', () => {
		const result = renderCurrentChunkView(baseView);
		expect(result).toContain('<b>-- Day Plan --</b>');
		expect(result).toContain('<b>Branch:</b> Day cycle');
		expect(result).toContain('<b>Chunk:</b> <code>10:00-12:00</code> Deep work');
		expect(result).toContain('Write report');
		expect(result).toContain('Review PR');
		expect(result).toContain('Reply to email');
		expect(result).toContain('Cancelled meeting');
	});

	it('Case A: renders status icons for active/completed/skipped/pending tasks', () => {
		const result = renderCurrentChunkView(baseView);
		// active: ▶
		expect(result).toContain('\u25B6 Write report');
		// completed: ✅
		expect(result).toContain('\u2705 Reply to email');
		// skipped: ⏭
		expect(result).toContain('\u23ED Cancelled meeting');
		// locked task gets the lock icon
		expect(result).toContain('Review PR \uD83D\uDD12');
	});

	it('Case A with zero tasks: renders "No tasks in this chunk." italic', () => {
		const view: CurrentChunkView = {
			...baseView,
			chunk: { ...baseView.chunk!, tasks: [] },
		};
		const result = renderCurrentChunkView(view);
		expect(result).toContain('<b>-- Day Plan --</b>');
		expect(result).toContain('<b>Chunk:</b> <code>10:00-12:00</code> Deep work');
		expect(result).toContain('<i>No tasks in this chunk.</i>');
	});

	it('Case B: chunk=null and nextChunkStartTime set renders "No active chunk. Next chunk starts at" copy', () => {
		const view: CurrentChunkView = {
			date: '2026-04-06',
			branchName: null,
			chunk: null,
			nextChunkStartTime: '14:00',
		};
		const result = renderCurrentChunkView(view);
		expect(result).toContain('<b>-- Day Plan --</b>');
		expect(result).toContain(
			'<i>No active chunk. Next chunk starts at <code>14:00</code>.</i>',
		);
		expect(result).not.toContain('Branch:');
	});

	it('Case C: chunk=null and nextChunkStartTime=null renders "No more chunks today."', () => {
		const view: CurrentChunkView = {
			date: '2026-04-06',
			branchName: null,
			chunk: null,
			nextChunkStartTime: null,
		};
		const result = renderCurrentChunkView(view);
		expect(result).toContain('<b>-- Day Plan --</b>');
		expect(result).toContain('<i>No more chunks today.</i>');
	});

	it('Case D: view=undefined renders "No plan for today yet." fallback', () => {
		const result = renderCurrentChunkView(undefined);
		expect(result).toContain('<b>-- Day Plan --</b>');
		expect(result).toContain('<i>No plan for today yet.</i>');
		expect(result).toContain('<i>Set a day tree and restart to generate.</i>');
	});

	it('escapes HTML in branch and chunk label and task labels', () => {
		const view: CurrentChunkView = {
			date: '2026-04-06',
			branchName: '<script>',
			chunk: {
				label: '<bad>',
				startTime: '10:00',
				endTime: '12:00',
				tasks: [{ label: '<evil>', status: 'pending', isLocked: false }],
			},
			nextChunkStartTime: null,
		};
		const result = renderCurrentChunkView(view);
		expect(result).toContain('&lt;script&gt;');
		expect(result).toContain('&lt;bad&gt;');
		expect(result).toContain('&lt;evil&gt;');
		expect(result).not.toContain('<script>');
	});
});

describe('renderCurrentChunkTasksView', () => {
	const baseView: CurrentChunkTasksView = {
		chunk: {
			label: 'Deep work',
			startTime: '10:00',
			endTime: '12:00',
			tasks: [
				{ id: 1, name: 'Write report', status: 'active', isEssential: false, timerStartedAt: null },
				{ id: 2, name: 'Review PR', status: 'pending', isEssential: true, timerStartedAt: null },
			],
		},
		nextChunkStartTime: null,
	};

	it('Case A: renders "-- Tasks --" title and chunk line (task buttons rendered by grammY)', () => {
		const result = renderCurrentChunkTasksView(baseView);
		expect(result).toContain('<b>-- Tasks --</b>');
		expect(result).toContain('<b>Chunk:</b> <code>10:00-12:00</code> Deep work');
		// Tasks view does NOT render branch line — only chunk
		expect(result).not.toContain('Branch:');
	});

	it('Case A with empty tasks: renders "No tasks in this chunk." italic', () => {
		const view: CurrentChunkTasksView = {
			chunk: { ...baseView.chunk!, tasks: [] },
			nextChunkStartTime: null,
		};
		const result = renderCurrentChunkTasksView(view);
		expect(result).toContain('<b>-- Tasks --</b>');
		expect(result).toContain('<b>Chunk:</b> <code>10:00-12:00</code> Deep work');
		expect(result).toContain('<i>No tasks in this chunk.</i>');
	});

	it('Case B: chunk=null and nextChunkStartTime set renders "No active chunk." copy', () => {
		const view: CurrentChunkTasksView = { chunk: null, nextChunkStartTime: '14:00' };
		const result = renderCurrentChunkTasksView(view);
		expect(result).toContain('<b>-- Tasks --</b>');
		expect(result).toContain(
			'<i>No active chunk. Next chunk starts at <code>14:00</code>.</i>',
		);
	});

	it('Case C: chunk=null and nextChunkStartTime=null renders "No more chunks today."', () => {
		const view: CurrentChunkTasksView = { chunk: null, nextChunkStartTime: null };
		const result = renderCurrentChunkTasksView(view);
		expect(result).toContain('<b>-- Tasks --</b>');
		expect(result).toContain('<i>No more chunks today.</i>');
	});

	it('Case D: view=undefined renders "No plan for today yet." fallback', () => {
		const result = renderCurrentChunkTasksView(undefined);
		expect(result).toContain('<b>-- Tasks --</b>');
		expect(result).toContain('<i>No plan for today yet.</i>');
		expect(result).toContain('<i>Set a day tree and restart to generate.</i>');
	});

	it('escapes HTML in chunk label', () => {
		const view: CurrentChunkTasksView = {
			chunk: {
				label: '<bad>',
				startTime: '10:00',
				endTime: '12:00',
				tasks: [],
			},
			nextChunkStartTime: null,
		};
		const result = renderCurrentChunkTasksView(view);
		expect(result).toContain('&lt;bad&gt;');
		expect(result).not.toContain('<bad>');
	});
});

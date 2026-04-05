import type { DailyPlanView } from '../../types/daily-plan.js';
import type { DayTree } from '../../types/day-tree.js';
import type { TaskDetail, TaskListItem } from '../../types/task.js';

export function escapeHtml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function formatDuration(seconds: number): string {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = seconds % 60;
	return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function formatTime(iso: string): string {
	const d = new Date(iso);
	return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

export function formatDateTime(iso: string): string {
	const d = new Date(iso);
	const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
	const time = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
	return `${date} ${time}`;
}

export interface HubViewState {
	status: 'idle' | 'running' | 'overdue' | 'disconnected';
	currentChunk: string | null;
	timer: string | null;
	timerSince: string | null;
}

export function renderHubView(state: HubViewState): string {
	const statusIcons: Record<HubViewState['status'], string> = {
		idle: '\u26AA Idle',
		running: '\uD83D\uDFE2 Running',
		overdue: '\uD83D\uDFE1 Overdue',
		disconnected: '\uD83D\uDD34 Disconnected',
	};

	const timerLine = state.timer
		? `\u23F1 <code>${escapeHtml(state.timer)}</code>`
		: '<code>--:--:--</code>';

	const hint = state.timer && state.timerSince
		? `<i>Timer running since ${state.timerSince}.</i>`
		: '<i>Ready when you are.</i>';

	return [
		'<b>-- Stitch Hub --</b>',
		'',
		`<b>Status:</b> ${statusIcons[state.status]}`,
		`<b>Current chunk:</b> ${state.currentChunk ? state.currentChunk : '<i>None</i>'}`,
		`<b>Timer:</b> ${timerLine}`,
		'',
		hint,
	].join('\n');
}

export function renderTreeView(tree: DayTree): string {
	const lines: string[] = ['<b>-- Day Tree --</b>', ''];
	for (const cycle of tree.cycles) {
		const slotIcon = cycle.isTaskSlot ? '[tasks]' : '[fixed]';
		lines.push(`<b>${escapeHtml(cycle.name)}</b> (${cycle.startTime}-${cycle.endTime}) ${slotIcon}`);
		if (cycle.items?.length) {
			for (const item of cycle.items) {
				const icon = item.type === 'fixed' ? '  -' : '  *';
				lines.push(`${icon} ${escapeHtml(item.label)}`);
			}
		}
		lines.push('');
	}
	return lines.join('\n');
}

export function renderDayPlanView(plan: DailyPlanView | undefined): string {
	if (!plan) {
		return [
			'<b>-- Day Plan --</b>',
			'',
			'<i>No plan for today yet.</i>',
			'<i>Set a day tree and restart to generate.</i>',
		].join('\n');
	}

	const lines: string[] = [
		`<b>-- Day Plan (${escapeHtml(plan.date)}) --</b>`,
		'',
	];

	for (const chunk of plan.chunks) {
		const statusIcon = chunk.status === 'completed' ? '\u2705 '
			: chunk.status === 'active' ? '\u25B6 '
			: chunk.status === 'skipped' ? '\u23ED '
			: '';
		lines.push(`${statusIcon}<b>${chunk.startTime}-${chunk.endTime}</b> ${escapeHtml(chunk.label)}`);

		if (chunk.tasks.length > 0) {
			for (const task of chunk.tasks) {
				const lockIcon = task.isLocked ? ' \uD83D\uDD12' : '';
				const taskStatus = task.status === 'completed' ? '\u2705 '
					: task.status === 'active' ? '\u25B6 '
					: '  ';
				lines.push(`  ${taskStatus}${escapeHtml(task.label)}${lockIcon}`);
			}
		}
		lines.push('');
	}

	return lines.join('\n');
}

export function renderTasksView(tasks: TaskListItem[]): string {
	if (tasks.length === 0) {
		return [
			'<b>-- Tasks --</b>',
			'',
			'<i>No tasks yet.</i>',
			'<i>Send "add Task name" to create one.</i>',
		].join('\n');
	}
	return ['<b>-- Tasks --</b>', '', 'Your tasks:'].join('\n');
}

export function renderTaskDetailView(task: TaskDetail): string {
	const lockIndicator = task.isEssential ? ' \uD83D\uDD12' : '';
	const lines: string[] = [
		`<b>-- Task #${task.id}${lockIndicator} --</b>`,
		'',
		`<b>Name:</b> ${escapeHtml(task.name)}`,
		`<b>Status:</b> ${task.status}`,
		`<b>Created:</b> <code>${formatDateTime(task.createdAt)}</code>`,
	];

	if (task.timerStartedAt) {
		lines.push('');
		lines.push(`\u23F1 <b>Timer running since</b> <code>${formatTime(task.timerStartedAt)}</code>`);
	}

	if (task.postponeCount > 0) {
		lines.push('');
		lines.push(`\u21A9 <i>Postponed ${task.postponeCount} times</i>`);
	}

	if (task.totalDurationSeconds != null) {
		lines.push('');
		lines.push(`<b>Total time:</b> <code>${formatDuration(task.totalDurationSeconds)}</code>`);
	}

	if (task.isEssential) {
		lines.push('');
		lines.push('<i>This task is locked and cannot be modified.</i>');
	}

	return lines.join('\n');
}

export function renderTaskListText(tasks: TaskListItem[]): string {
	if (tasks.length === 0) {
		return 'No tasks. Send "add Task name" to create one.';
	}

	const statusEmoji: Record<string, string> = {
		pending: '',
		active: '\u25B6 ',
		completed: '\u2705 ',
		skipped: '\u23ED ',
	};

	return tasks
		.map((task, i) => {
			const prefix = task.isEssential ? '\uD83D\uDD12 ' : statusEmoji[task.status] || '';
			return `${i + 1}. ${prefix}${task.name} (${task.status})`;
		})
		.join('\n');
}


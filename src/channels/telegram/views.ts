import type {
	CurrentChunkTasksView,
	CurrentChunkView,
	DailyPlanView,
} from '../../types/daily-plan.js';
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

	const hint =
		state.timer && state.timerSince
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
	for (const branch of tree.branches) {
		const slotIcon = branch.isTaskSlot ? '[tasks]' : '[fixed]';
		lines.push(
			`<b>${escapeHtml(branch.name)}</b> (${branch.startTime}-${branch.endTime}) ${slotIcon}`,
		);
		if (branch.items?.length) {
			for (const item of branch.items) {
				const icon = item.type === 'fixed' ? '  -' : '  *';
				lines.push(`${icon} ${escapeHtml(item.label)}`);
			}
		}
		lines.push('');
	}
	return lines.join('\n');
}

/**
 * Render the day plan as full-text HTML. mode='full' is the default and
 * produces the "-- Full Day Plan ({date}) --" title for Screen 2 (drill-down).
 * mode='focused' preserves the legacy "-- Day Plan ({date}) --" title for any
 * existing caller that has not migrated to renderCurrentChunkView yet.
 *
 * The undefined-plan branch always renders "<b>-- Day Plan --</b>" (no date,
 * no mode prefix) since there is no plan to label.
 */
export function renderDayPlanView(plan?: DailyPlanView, mode: 'focused' | 'full' = 'full'): string {
	if (!plan) {
		return [
			'<b>-- Day Plan --</b>',
			'',
			'<i>No plan for today yet.</i>',
			'<i>Set a day tree and restart to generate.</i>',
		].join('\n');
	}

	const titlePrefix = mode === 'full' ? '-- Full Day Plan' : '-- Day Plan';
	const lines: string[] = [`<b>${titlePrefix} (${escapeHtml(plan.date)}) --</b>`, ''];

	for (const chunk of plan.chunks) {
		const statusIcon =
			chunk.status === 'completed'
				? '\u2705 '
				: chunk.status === 'active'
					? '\u25B6 '
					: chunk.status === 'skipped'
						? '\u23ED '
						: '';
		lines.push(
			`${statusIcon}<b>${chunk.startTime}-${chunk.endTime}</b> ${escapeHtml(chunk.label)}`,
		);

		// Phase 10 (D-16): chunk rollup sub-line.
		const chunkRollup =
			chunk.predictedSumMinutes != null
				? `  <i>${chunk.slotDurationMinutes}min slot \u00B7 ~${chunk.predictedSumMinutes}min predicted</i>`
				: `  <i>${chunk.slotDurationMinutes}min slot</i>`;
		lines.push(chunkRollup);

		if (chunk.tasks.length > 0) {
			for (const task of chunk.tasks) {
				const lockIcon = task.isLocked ? ' \uD83D\uDD12' : '';
				const taskStatus =
					task.status === 'completed' ? '\u2705 ' : task.status === 'active' ? '\u25B6 ' : '  ';
				// Phase 10 (D-15): prediction suffix.
				const predSuffix =
					task.predictedMaxSeconds != null
						? ` ~${Math.round(task.predictedMaxSeconds / 60)}min (${task.predictedConfidence})`
						: '';
				lines.push(`  ${taskStatus}${escapeHtml(task.label)}${lockIcon}${predSuffix}`);
			}
		}
		lines.push('');
	}

	return lines.join('\n');
}

/**
 * Phase 08.3 Screen 1: focused Day Plan default view.
 *
 * Cases (per UI-SPEC §Screen 1 and CONTEXT D-04/D-07/D-08):
 *   - undefined view              -> Case D: "No plan for today yet." fallback
 *   - chunk === null && next set  -> Case B: "No active chunk. Next chunk starts at HH:MM."
 *   - chunk === null && next null -> Case C: "No more chunks today."
 *   - chunk !== null, tasks empty -> Case A header + "No tasks in this chunk."
 *   - chunk !== null, tasks > 0   -> Case A header + task list with status icons
 *
 * Title is always "<b>-- Day Plan --</b>" (no date) — disambiguates from
 * "<b>-- Full Day Plan ({date}) --</b>" produced by renderDayPlanView(plan, 'full').
 */
export function renderCurrentChunkView(view: CurrentChunkView | undefined): string {
	if (!view) {
		return [
			'<b>-- Day Plan --</b>',
			'',
			'<i>No plan for today yet.</i>',
			'<i>Set a day tree and restart to generate.</i>',
		].join('\n');
	}

	if (!view.chunk) {
		const body = view.nextChunkStartTime
			? `<i>No active chunk. Next chunk starts at <code>${view.nextChunkStartTime}</code>.</i>`
			: '<i>No more chunks today.</i>';
		return ['<b>-- Day Plan --</b>', '', body].join('\n');
	}

	const lines: string[] = [
		'<b>-- Day Plan --</b>',
		'',
		`<b>Branch:</b> ${escapeHtml(view.branchName ?? '')}`,
		`<b>Chunk:</b> <code>${view.chunk.startTime}-${view.chunk.endTime}</code> ${escapeHtml(view.chunk.label)}`,
	];

	// Phase 10 (D-16): chunk rollup — `Nmin slot · ~Mmin predicted`
	// or just `Nmin slot` when all tasks have null predictions.
	// U+00B7 middle dot is the literal '\u00B7' character.
	const rollup =
		view.chunk.predictedSumMinutes != null
			? `<i>${view.chunk.slotDurationMinutes}min slot \u00B7 ~${view.chunk.predictedSumMinutes}min predicted</i>`
			: `<i>${view.chunk.slotDurationMinutes}min slot</i>`;
	lines.push(rollup);
	lines.push('');

	if (view.chunk.tasks.length === 0) {
		lines.push('<i>No tasks in this chunk.</i>');
	} else {
		for (const task of view.chunk.tasks) {
			const statusIcon =
				task.status === 'completed'
					? '\u2705 '
					: task.status === 'active'
						? '\u25B6 '
						: task.status === 'skipped'
							? '\u23ED '
							: '  ';
			const lockIcon = task.isLocked ? ' \uD83D\uDD12' : '';
			// Phase 10 (D-15): prediction suffix, ` ~25min (high)` — only when set.
			const predSuffix =
				task.predictedMaxSeconds != null
					? ` ~${Math.round(task.predictedMaxSeconds / 60)}min (${task.predictedConfidence})`
					: '';
			lines.push(`${statusIcon}${escapeHtml(task.label)}${lockIcon}${predSuffix}`);
		}
	}
	return lines.join('\n');
}

/**
 * Phase 08.3 Screen 3: scoped Tasks default view (text portion only).
 *
 * Renders the "-- Tasks --" header, the current chunk identifier line, and the
 * empty-state copy. The actual per-task buttons are rendered by grammY in
 * Wave 3 — this function only produces the text body, NOT the task list.
 *
 * Cases mirror renderCurrentChunkView but the body has NO branch line.
 */
export function renderCurrentChunkTasksView(view: CurrentChunkTasksView | undefined): string {
	if (!view) {
		return [
			'<b>-- Tasks --</b>',
			'',
			'<i>No plan for today yet.</i>',
			'<i>Set a day tree and restart to generate.</i>',
		].join('\n');
	}

	if (!view.chunk) {
		const body = view.nextChunkStartTime
			? `<i>No active chunk. Next chunk starts at <code>${view.nextChunkStartTime}</code>.</i>`
			: '<i>No more chunks today.</i>';
		return ['<b>-- Tasks --</b>', '', body].join('\n');
	}

	const lines: string[] = [
		'<b>-- Tasks --</b>',
		'',
		`<b>Chunk:</b> <code>${view.chunk.startTime}-${view.chunk.endTime}</code> ${escapeHtml(view.chunk.label)}`,
	];

	if (view.chunk.tasks.length === 0) {
		lines.push('');
		lines.push('<i>No tasks in this chunk.</i>');
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

/**
 * Phase 10 (D-18): format a task completion message with prediction diff.
 *
 * Output shape:
 *   Without prediction: `Done: {taskName} (#{taskId})`
 *   With prediction:    `Done: {taskName} (#{taskId})
 *                        Predicted ~25min \u00B7 Actual 32min (+7).`
 *
 * Plain text (no HTML). The middle-dot separator is U+00B7 (\u00B7).
 * Drift is signed integer minutes: positive means over-ran (+7), negative
 * means finished early (-3), zero means exactly matched (+0).
 */
export function formatCompletionWithDiff(
	taskName: string,
	taskId: number,
	actualSeconds: number,
	predictedMaxSeconds: number | null,
	predictedConfidence: 'low' | 'medium' | 'high' | null,
): string {
	const base = `Done: ${taskName} (#${taskId})`;
	if (predictedMaxSeconds == null) return base;
	void predictedConfidence; // currently unused in D-18 format, reserved for future iteration

	const predictedMin = Math.round(predictedMaxSeconds / 60);
	const actualMin = Math.round(actualSeconds / 60);
	const driftMin = actualMin - predictedMin;
	const driftStr = driftMin >= 0 ? `+${driftMin}` : `${driftMin}`;
	return `${base}\nPredicted ~${predictedMin}min \u00B7 Actual ${actualMin}min (${driftStr}).`;
}

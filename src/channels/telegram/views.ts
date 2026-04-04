export interface HubViewState {
	status: 'idle' | 'running' | 'overdue' | 'disconnected';
	currentChunk: string | null;
	timer: string | null;
}

export function renderHubView(state: HubViewState): string {
	const statusIcons: Record<HubViewState['status'], string> = {
		idle: '\u26AA Idle',
		running: '\uD83D\uDFE2 Running',
		overdue: '\uD83D\uDFE1 Overdue',
		disconnected: '\uD83D\uDD34 Disconnected',
	};
	return [
		'<b>-- Stitch Hub --</b>',
		'',
		`<b>Status:</b> ${statusIcons[state.status]}`,
		`<b>Current chunk:</b> ${state.currentChunk ? state.currentChunk : '<i>None</i>'}`,
		`<b>Timer:</b> ${state.timer ? `<code>${state.timer}</code>` : '<code>--:--:--</code>'}`,
		'',
		'<i>Ready when you are.</i>',
	].join('\n');
}

export function renderDayPlanView(): string {
	return [
		'<b>-- Day Plan --</b>',
		'',
		'<i>No plan for today yet.</i>',
		'<i>Plans are generated in a future update.</i>',
	].join('\n');
}

export function renderTasksView(): string {
	return [
		'<b>-- Tasks --</b>',
		'',
		'<i>No tasks yet.</i>',
		'<i>Task management coming in a future update.</i>',
	].join('\n');
}

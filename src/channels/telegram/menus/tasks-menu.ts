import { Menu } from '@grammyjs/menu';
import type { TaskService } from '../../../core/task-service.js';
import type { TaskListItem } from '../../../types/task.js';
import type { StitchContext } from '../types.js';
import { renderHubView, renderTaskDetailView, renderTasksView } from '../views.js';

const STATUS_ORDER: Record<string, number> = {
	active: 0,
	pending: 1,
	completed: 2,
	skipped: 3,
};

function taskButtonLabel(task: TaskListItem): string {
	const maxLen = 30;
	const name = task.name.length > maxLen ? `${task.name.slice(0, maxLen)}...` : task.name;

	if (task.timerStartedAt) return `\u25B6 ${name}`;
	if (task.isEssential) return `\uD83D\uDD12 ${name}`;
	if (task.status === 'completed') return `\u2705 ${name}`;
	if (task.status === 'skipped') return `\u23ED ${name}`;
	return name;
}

export function createTasksMenu(taskService: TaskService): {
	tasksMenu: Menu<StitchContext>;
	taskDetailMenu: Menu<StitchContext>;
} {
	const tasksMenu = new Menu<StitchContext>('tasks')
		.dynamic((_ctx, range) => {
			const allTasks = taskService.list() as TaskListItem[];
			const sorted = [...allTasks].sort(
				(a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9),
			);
			const limited = sorted.slice(0, 20);

			for (const task of limited) {
				range
					.text(
						{ text: taskButtonLabel(task), payload: String(task.id) },
						async (ctx) => {
							try {
								const detail = taskService.getTaskDetail(Number(ctx.match));
								if (detail) {
									await ctx.editMessageText(renderTaskDetailView(detail), {
										parse_mode: 'HTML',
									});
									ctx.menu.nav('task-detail');
								}
							} catch (err) {
								await ctx.editMessageText(String((err as Error).message), {
									parse_mode: 'HTML',
								});
							}
						},
					)
					.row();
			}
			return range;
		})
		.text('<< Back to Hub', async (ctx) => {
			ctx.menu.nav('hub');
			await ctx.editMessageText(
				renderHubView({
					status: 'idle',
					currentChunk: null,
					timer: null,
					timerSince: null,
				}),
				{ parse_mode: 'HTML' },
			);
		});

	const taskDetailMenu = new Menu<StitchContext>('task-detail')
		.dynamic((ctx, range) => {
			const taskId = ctx.match;
			if (!taskId) return range;

			const task = taskService.getById(Number(taskId));
			if (!task) return range;

			// Completed or skipped: only back button
			if (task.status === 'completed' || task.status === 'skipped') {
				return range;
			}

			// Timer running: only Stop Timer
			if (task.timerStartedAt) {
				range
					.text('Stop Timer', async (ctx) => {
						try {
							taskService.stopTimer(task.id);
							const detail = taskService.getTaskDetail(task.id);
							if (detail) {
								await ctx.editMessageText(renderTaskDetailView(detail), {
									parse_mode: 'HTML',
								});
							}
						} catch (err) {
							await ctx.editMessageText(String((err as Error).message), {
								parse_mode: 'HTML',
							});
						}
					})
					.row();
				return range;
			}

			// Timer not running, status pending or active: Start Timer
			if (task.status === 'pending' || task.status === 'active') {
				range
					.text('Start Timer', async (ctx) => {
						try {
							taskService.startTimer(task.id);
							const detail = taskService.getTaskDetail(task.id);
							if (detail) {
								await ctx.editMessageText(renderTaskDetailView(detail), {
									parse_mode: 'HTML',
								});
							}
						} catch (err) {
							await ctx.editMessageText(String((err as Error).message), {
								parse_mode: 'HTML',
							});
						}
					})
					.row();
			}

			// Not essential, not timer running, pending: Postpone + Complete
			if (!task.isEssential && task.status === 'pending') {
				range
					.text('Postpone', async (ctx) => {
						try {
							taskService.postpone(task.id);
							const detail = taskService.getTaskDetail(task.id);
							if (detail) {
								await ctx.editMessageText(renderTaskDetailView(detail), {
									parse_mode: 'HTML',
								});
							}
						} catch (err) {
							await ctx.editMessageText(String((err as Error).message), {
								parse_mode: 'HTML',
							});
						}
					})
					.text('Complete', async (ctx) => {
						try {
							taskService.update(task.id, { status: 'completed' });
							const allTasks = taskService.list() as TaskListItem[];
							await ctx.editMessageText(renderTasksView(allTasks), {
								parse_mode: 'HTML',
							});
							ctx.menu.nav('tasks');
						} catch (err) {
							await ctx.editMessageText(String((err as Error).message), {
								parse_mode: 'HTML',
							});
						}
					})
					.row();
			}

			// Essential, not timer running: Complete only (completed/skipped already returned early)
			if (task.isEssential) {
				range
					.text('Complete', async (ctx) => {
						try {
							taskService.update(task.id, { status: 'completed' });
							const allTasks = taskService.list() as TaskListItem[];
							await ctx.editMessageText(renderTasksView(allTasks), {
								parse_mode: 'HTML',
							});
							ctx.menu.nav('tasks');
						} catch (err) {
							await ctx.editMessageText(String((err as Error).message), {
								parse_mode: 'HTML',
							});
						}
					})
					.row();
			}

			// Not essential, not timer running: Delete
			if (!task.isEssential) {
				range
					.text('Delete', async (ctx) => {
						try {
							taskService.delete(task.id);
							const allTasks = taskService.list() as TaskListItem[];
							await ctx.editMessageText(renderTasksView(allTasks), {
								parse_mode: 'HTML',
							});
							ctx.menu.nav('tasks');
						} catch (err) {
							await ctx.editMessageText(String((err as Error).message), {
								parse_mode: 'HTML',
							});
						}
					})
					.row();
			}

			return range;
		})
		.text('<< Back to Tasks', async (ctx) => {
			const allTasks = taskService.list() as TaskListItem[];
			await ctx.editMessageText(renderTasksView(allTasks), {
				parse_mode: 'HTML',
			});
			ctx.menu.nav('tasks');
		});

	return { tasksMenu, taskDetailMenu };
}

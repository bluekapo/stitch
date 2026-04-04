import { Menu } from '@grammyjs/menu';
import type { TaskService } from '../../../core/task-service.js';
import type { TaskListItem } from '../../../types/task.js';
import type { StitchContext } from '../types.js';
import { renderDayPlanView, renderHubView, renderTasksView } from '../views.js';

export function createHubMenu(taskService: TaskService): Menu<StitchContext> {
	const menu = new Menu<StitchContext>('hub')
		.text('Day Plan', async (ctx) => {
			await ctx.editMessageText(renderDayPlanView(), { parse_mode: 'HTML' });
			ctx.menu.nav('day-plan');
		})
		.text('Tasks', async (ctx) => {
			const allTasks = taskService.list() as TaskListItem[];
			await ctx.editMessageText(renderTasksView(allTasks), { parse_mode: 'HTML' });
			ctx.menu.nav('tasks');
		})
		.row()
		.text('Status', async (ctx) => {
			await ctx.editMessageText(
				renderHubView({ status: 'idle', currentChunk: null, timer: null, timerSince: null }),
				{ parse_mode: 'HTML' },
			);
		});

	return menu;
}

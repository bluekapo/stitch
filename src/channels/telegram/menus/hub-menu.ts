import { Menu } from '@grammyjs/menu';
import type { TaskService } from '../../../core/task-service.js';
import type { TaskListItem } from '../../../types/task.js';
import type { StitchContext } from '../types.js';
import { renderDayPlanView, renderTasksView } from '../views.js';

export function createHubMenu(taskService: TaskService): Menu<StitchContext> {
	const menu = new Menu<StitchContext>('hub')
		.text('Day Plan', async (ctx) => {
			ctx.menu.nav('day-plan');
			await ctx.editMessageText(renderDayPlanView(), { parse_mode: 'HTML' });
		})
		.text('Tasks', async (ctx) => {
			const allTasks = taskService.list() as TaskListItem[];
			ctx.menu.nav('tasks');
			await ctx.editMessageText(renderTasksView(allTasks), { parse_mode: 'HTML' });
		})
		.row()
		.text('Status', async (ctx) => {
			await ctx.answerCallbackQuery('Status: idle');
		});

	return menu;
}

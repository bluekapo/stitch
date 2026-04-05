import { Menu } from '@grammyjs/menu';
import type { DailyPlanService } from '../../../core/daily-plan-service.js';
import type { TaskService } from '../../../core/task-service.js';
import type { DailyPlanView } from '../../../types/daily-plan.js';
import type { TaskListItem } from '../../../types/task.js';
import type { StitchContext } from '../types.js';
import { renderDayPlanView, renderTasksView } from '../views.js';

export function createHubMenu(taskService: TaskService, dailyPlanService?: DailyPlanService): Menu<StitchContext> {
	const menu = new Menu<StitchContext>('hub')
		.text('Day Plan', async (ctx) => {
			let planView: DailyPlanView | undefined;
			if (dailyPlanService) {
				const plan = dailyPlanService.getTodayPlan();
				if (plan) {
					const chunks = dailyPlanService.getPlanChunks(plan.id);
					planView = {
						date: plan.date,
						chunks: chunks.map(c => ({
							label: c.label,
							startTime: c.startTime,
							endTime: c.endTime,
							isLocked: c.isLocked,
							status: c.status,
						})),
					};
				}
			}
			ctx.menu.nav('day-plan');
			await ctx.editMessageText(renderDayPlanView(planView), { parse_mode: 'HTML' });
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

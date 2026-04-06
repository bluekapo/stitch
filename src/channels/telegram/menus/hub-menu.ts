import { Menu } from '@grammyjs/menu';
import type { DailyPlanService } from '../../../core/daily-plan-service.js';
import type { TaskService } from '../../../core/task-service.js';
import type { StitchContext } from '../types.js';
import {
	buildCurrentChunkTasksView,
	buildCurrentChunkView,
} from '../view-builders.js';
import {
	renderCurrentChunkTasksView,
	renderCurrentChunkView,
} from '../views.js';
import { safeEditMessageText } from './helpers.js';

export function createHubMenu(taskService: TaskService, dailyPlanService?: DailyPlanService): Menu<StitchContext> {
	const menu = new Menu<StitchContext>('hub')
		.text('Day Plan', async (ctx) => {
			ctx.menu.nav('day-plan');
			await safeEditMessageText(
				ctx,
				renderCurrentChunkView(buildCurrentChunkView(dailyPlanService)),
			);
		})
		.text('Tasks', async (ctx) => {
			ctx.menu.nav('tasks');
			await safeEditMessageText(
				ctx,
				renderCurrentChunkTasksView(
					buildCurrentChunkTasksView(taskService, dailyPlanService),
				),
			);
		});

	return menu;
}

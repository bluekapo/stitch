import type { Menu } from '@grammyjs/menu';
import type { Bot } from 'grammy';
import type { DailyPlanService } from '../../../core/daily-plan-service.js';
import type { DayTreeService } from '../../../core/day-tree-service.js';
import type { TaskService } from '../../../core/task-service.js';
import type { StitchContext } from '../types.js';
import { createDayPlanMenu } from './day-plan-menu.js';
import { createHubMenu } from './hub-menu.js';
import { createTasksMenu } from './tasks-menu.js';

export interface RegisteredMenus {
	hubMenu: Menu<StitchContext>;
	dayPlanMenu: Menu<StitchContext>;
	tasksMenu: Menu<StitchContext>;
	taskDetailMenu: Menu<StitchContext>;
}

export function registerMenus(
	bot: Bot<StitchContext>,
	taskService: TaskService,
	dailyPlanService?: DailyPlanService,
	dayTreeService?: DayTreeService,
): RegisteredMenus {
	const hubMenu = createHubMenu(taskService, dailyPlanService);
	const dayPlanMenu = createDayPlanMenu(dayTreeService, dailyPlanService);
	const { tasksMenu, taskDetailMenu } = createTasksMenu(taskService);

	// Register submenus on parent before bot.use (Pitfall 6)
	hubMenu.register(dayPlanMenu);
	hubMenu.register(tasksMenu);
	tasksMenu.register(taskDetailMenu);

	// Install root menu on bot
	bot.use(hubMenu);

	return { hubMenu, dayPlanMenu, tasksMenu, taskDetailMenu };
}

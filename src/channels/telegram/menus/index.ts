import type { Bot } from 'grammy';
import type { Menu } from '@grammyjs/menu';
import type { StitchContext } from '../types.js';
import { createHubMenu } from './hub-menu.js';
import { createDayPlanMenu } from './day-plan-menu.js';
import { createTasksMenu } from './tasks-menu.js';

export interface RegisteredMenus {
	hubMenu: Menu<StitchContext>;
	dayPlanMenu: Menu<StitchContext>;
	tasksMenu: Menu<StitchContext>;
}

export function registerMenus(bot: Bot<StitchContext>): RegisteredMenus {
	const hubMenu = createHubMenu();
	const dayPlanMenu = createDayPlanMenu();
	const tasksMenu = createTasksMenu();

	// Register submenus on parent before bot.use (Pitfall 6)
	hubMenu.register(dayPlanMenu);
	hubMenu.register(tasksMenu);

	// Install root menu on bot
	bot.use(hubMenu);

	return { hubMenu, dayPlanMenu, tasksMenu };
}

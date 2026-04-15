import type { Menu } from '@grammyjs/menu';
import type { Bot } from 'grammy';
import type { Logger } from 'pino';
import type { CheckInService } from '../../../core/check-in-service.js';
import type { DailyPlanService } from '../../../core/daily-plan-service.js';
import type { DayTreeService } from '../../../core/day-tree-service.js';
import type { TaskService } from '../../../core/task-service.js';
import type { StitchDb } from '../../../db/index.js';
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
	checkInService?: CheckInService, // Phase 9 D-05.4 (Blocker 4)
	db?: StitchDb, // Phase 10 D-18: prediction lookup for completion diff
	logger?: Logger, // Phase 12 D-11: threaded to tasks-menu for hub-button req_id (Pitfall 8)
): RegisteredMenus {
	const hubMenu = createHubMenu(taskService, dailyPlanService);
	const dayPlanMenu = createDayPlanMenu(dayTreeService, dailyPlanService);
	const { tasksMenu, taskDetailMenu } = createTasksMenu(
		taskService,
		dailyPlanService,
		checkInService,
		db,
		logger,
	);

	// Register top-level submenus on parent before bot.use (Pitfall 6).
	// Note: createTasksMenu already registers task-detail-from-chunk under
	// tasksMenu, plus all-tasks under tasksMenu and task-detail-from-all
	// under all-tasks. We only need to attach tasksMenu and dayPlanMenu to hub.
	hubMenu.register(dayPlanMenu);
	hubMenu.register(tasksMenu);

	// Install root menu on bot
	bot.use(hubMenu);

	return { hubMenu, dayPlanMenu, tasksMenu, taskDetailMenu };
}

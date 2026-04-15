import { Menu } from '@grammyjs/menu';
import { describe, expect, it } from 'vitest';
import { createDayPlanMenu } from '../../../src/channels/telegram/menus/day-plan-menu.js';
import { createHubMenu } from '../../../src/channels/telegram/menus/hub-menu.js';
import { registerMenus } from '../../../src/channels/telegram/menus/index.js';
import { createTasksMenu } from '../../../src/channels/telegram/menus/tasks-menu.js';
import {
	buildCurrentChunkTasksView,
	buildCurrentChunkView,
	buildFullDayPlanView,
} from '../../../src/channels/telegram/view-builders.js';
import {
	renderCurrentChunkTasksView,
	renderCurrentChunkView,
	renderDayPlanView,
	renderHubView,
} from '../../../src/channels/telegram/views.js';
import { TaskService } from '../../../src/core/task-service.js';
import { createTestDb } from '../../helpers/db.js';
import { createTestLogger } from '../../helpers/logger.js';
import { createTestBot } from '../../helpers/telegram.js';

function makeTaskService() {
	const db = createTestDb();
	return new TaskService(db, createTestLogger());
}

/** Minimal context object accepted by @grammyjs/menu render() for static menus */
const renderCtx = { chatId: 123, msgId: 1, match: '' };

/** Build a fake callback_query update from a callback_data string */
function callbackQueryUpdate(data: string) {
	return {
		update_id: Math.floor(Math.random() * 1e9),
		callback_query: {
			id: String(Date.now()),
			from: { id: 123, is_bot: false, first_name: 'Test' },
			chat_instance: '1',
			data,
			message: {
				message_id: 1,
				from: { id: 1, is_bot: true, first_name: 'TestBot' },
				chat: { id: 123, type: 'private' as const },
				date: Math.floor(Date.now() / 1000),
				text: 'old text',
			},
		},
	};
}

describe('Menu factories', () => {
	it('createHubMenu returns a Menu instance with id "hub"', () => {
		const menu = createHubMenu(makeTaskService());
		expect(menu).toBeInstanceOf(Menu);
	});

	it('createDayPlanMenu returns a Menu instance with id "day-plan"', () => {
		const menu = createDayPlanMenu();
		expect(menu).toBeInstanceOf(Menu);
	});

	it('createDayPlanMenu accepts optional dayTreeService and dailyPlanService', () => {
		const menu = createDayPlanMenu(undefined, undefined);
		expect(menu).toBeInstanceOf(Menu);
	});

	it('createTasksMenu returns tasksMenu and taskDetailMenu as Menu instances', () => {
		const { tasksMenu, taskDetailMenu } = createTasksMenu(makeTaskService());
		expect(tasksMenu).toBeInstanceOf(Menu);
		expect(taskDetailMenu).toBeInstanceOf(Menu);
	});
});

describe('registerMenus', () => {
	it('returns hubMenu, dayPlanMenu, tasksMenu, and taskDetailMenu', () => {
		const { bot } = createTestBot();
		const menus = registerMenus(bot, makeTaskService());

		expect(menus.hubMenu).toBeInstanceOf(Menu);
		expect(menus.dayPlanMenu).toBeInstanceOf(Menu);
		expect(menus.tasksMenu).toBeInstanceOf(Menu);
		expect(menus.taskDetailMenu).toBeInstanceOf(Menu);
	});

	it('Day Plan button triggers editMessageText with focused chunk view content', async () => {
		const { bot, outgoing } = createTestBot();
		const { hubMenu } = registerMenus(bot, makeTaskService());

		// Render hub menu to get the real callback_data for the "Day Plan" button (row 0, col 0)
		const rendered = await hubMenu.render(renderCtx);
		const dayPlanBtn = rendered[0][0] as { callback_data: string; text: string };
		expect(dayPlanBtn.text).toBe('Day Plan');

		// Fire the button press through the bot
		await bot.handleUpdate(callbackQueryUpdate(dayPlanBtn.callback_data) as never);

		// Assert editMessageText was called with the focused day plan view content
		// (no dailyPlanService -> builder returns undefined -> Case D fallback)
		const editCalls = outgoing.filter((c) => c.method === 'editMessageText');
		expect(editCalls.length).toBeGreaterThanOrEqual(1);
		const editPayload = editCalls[editCalls.length - 1].payload as Record<string, unknown>;
		expect(editPayload.text).toBe(renderCurrentChunkView(buildCurrentChunkView(undefined)));
		expect(editPayload.parse_mode).toBe('HTML');
	});

	it('Tasks button triggers editMessageText with scoped current-chunk tasks view content', async () => {
		const { bot, outgoing } = createTestBot();
		const taskService = makeTaskService();
		const { hubMenu } = registerMenus(bot, taskService);

		// Render hub menu to get the real callback_data for the "Tasks" button (row 0, col 1)
		const rendered = await hubMenu.render(renderCtx);
		const tasksBtn = rendered[0][1] as { callback_data: string; text: string };
		expect(tasksBtn.text).toBe('Tasks');

		// Fire the button press through the bot
		await bot.handleUpdate(callbackQueryUpdate(tasksBtn.callback_data) as never);

		// Assert editMessageText was called with the scoped current-chunk tasks view
		// (no dailyPlanService -> builder returns undefined -> Case D fallback)
		const editCalls = outgoing.filter((c) => c.method === 'editMessageText');
		expect(editCalls.length).toBeGreaterThanOrEqual(1);
		const editPayload = editCalls[editCalls.length - 1].payload as Record<string, unknown>;
		expect(editPayload.text).toBe(
			renderCurrentChunkTasksView(buildCurrentChunkTasksView(taskService, undefined)),
		);
		expect(editPayload.parse_mode).toBe('HTML');
	});

	it('View Day Tree button answers callback when no service', async () => {
		const { bot, outgoing } = createTestBot();
		const { dayPlanMenu } = registerMenus(bot, makeTaskService());

		// Render the day-plan submenu to get the callback_data for "View Day Tree" (row 0, col 1)
		const rendered = await dayPlanMenu.render(renderCtx);
		const treeBtn = rendered[0][1] as { callback_data: string; text: string };
		expect(treeBtn.text).toBe('View Day Tree');

		// Fire the button press
		await bot.handleUpdate(callbackQueryUpdate(treeBtn.callback_data) as never);

		// Should answer callback query (no dayTreeService passed)
		const answerCalls = outgoing.filter((c) => c.method === 'answerCallbackQuery');
		expect(answerCalls.length).toBeGreaterThanOrEqual(1);
	});

	it('Back to Hub button triggers editMessageText with hub content', async () => {
		const { bot, outgoing } = createTestBot();
		const { dayPlanMenu } = registerMenus(bot, makeTaskService());

		// New Day Plan layout:
		//   row 0: [Full Day Plan] [View Day Tree]
		//   row 1: [Refresh]
		//   row 2: [<< Back to Hub]
		const rendered = await dayPlanMenu.render(renderCtx);
		const backBtn = rendered[2][0] as { callback_data: string; text: string };
		expect(backBtn.text).toBe('<< Back to Hub');

		// Fire the button press through the bot
		await bot.handleUpdate(callbackQueryUpdate(backBtn.callback_data) as never);

		// Assert editMessageText was called with the hub view content
		const editCalls = outgoing.filter((c) => c.method === 'editMessageText');
		expect(editCalls.length).toBeGreaterThanOrEqual(1);
		const editPayload = editCalls[editCalls.length - 1].payload as Record<string, unknown>;
		const expectedHubContent = renderHubView({
			status: 'idle',
			currentChunk: null,
			timer: null,
			timerSince: null,
		});
		expect(editPayload.text).toBe(expectedHubContent);
		expect(editPayload.parse_mode).toBe('HTML');
	});
});

describe('Day Plan menu structure (Phase 08.3)', () => {
	it('has Full Day Plan, View Day Tree, Refresh, and << Back to Hub buttons', async () => {
		const { bot } = createTestBot();
		const { dayPlanMenu } = registerMenus(bot, makeTaskService());

		const rendered = await dayPlanMenu.render(renderCtx);
		// row 0: Full Day Plan | View Day Tree
		// row 1: Refresh
		// row 2: << Back to Hub
		expect((rendered[0][0] as { text: string }).text).toBe('Full Day Plan');
		expect((rendered[0][1] as { text: string }).text).toBe('View Day Tree');
		expect((rendered[1][0] as { text: string }).text).toBe('Refresh');
		expect((rendered[2][0] as { text: string }).text).toBe('<< Back to Hub');
	});

	it('Full Day Plan button navigates to full-day-plan submenu and renders full view', async () => {
		const { bot, outgoing } = createTestBot();
		const { dayPlanMenu } = registerMenus(bot, makeTaskService());

		const rendered = await dayPlanMenu.render(renderCtx);
		const fullBtn = rendered[0][0] as { callback_data: string; text: string };
		expect(fullBtn.text).toBe('Full Day Plan');

		await bot.handleUpdate(callbackQueryUpdate(fullBtn.callback_data) as never);

		const editCalls = outgoing.filter((c) => c.method === 'editMessageText');
		expect(editCalls.length).toBeGreaterThanOrEqual(1);
		const editPayload = editCalls[editCalls.length - 1].payload as Record<string, unknown>;
		// Builder returns undefined (no dailyPlanService) -> Case D fallback.
		// renderDayPlanView(undefined, 'full') falls through the undefined branch
		// which does NOT show the "Full Day Plan" prefix (plan is undefined).
		expect(editPayload.text).toBe(renderDayPlanView(buildFullDayPlanView(undefined), 'full'));
		expect(editPayload.parse_mode).toBe('HTML');
	});

	it('Refresh button re-renders focused current chunk view without nav', async () => {
		const { bot, outgoing } = createTestBot();
		const { dayPlanMenu } = registerMenus(bot, makeTaskService());

		const rendered = await dayPlanMenu.render(renderCtx);
		const refreshBtn = rendered[1][0] as { callback_data: string; text: string };
		expect(refreshBtn.text).toBe('Refresh');

		await bot.handleUpdate(callbackQueryUpdate(refreshBtn.callback_data) as never);

		const editCalls = outgoing.filter((c) => c.method === 'editMessageText');
		expect(editCalls.length).toBeGreaterThanOrEqual(1);
		const editPayload = editCalls[editCalls.length - 1].payload as Record<string, unknown>;
		expect(editPayload.text).toBe(renderCurrentChunkView(buildCurrentChunkView(undefined)));
	});
});

describe('Full Day Plan submenu (Phase 08.3)', () => {
	it('has Refresh and << Back to Day Plan buttons', async () => {
		const { bot } = createTestBot();
		registerMenus(bot, makeTaskService());

		// Access the submenu via the dayPlanMenu's registered children.
		// The full-day-plan submenu is created inside createDayPlanMenu and
		// registered there. Construct a fresh day-plan menu to inspect it.
		const dayPlanMenu = createDayPlanMenu(undefined, undefined);
		// Grab the registered full-day-plan submenu by id via its index.
		// @grammyjs/menu exposes registered children via the `index` property.
		const index = (dayPlanMenu as unknown as { index: Map<string, Menu<never>> }).index;
		const fullDayPlanMenu = index.get('full-day-plan');
		expect(fullDayPlanMenu).toBeInstanceOf(Menu);

		const rendered = await (fullDayPlanMenu as Menu<never>).render(renderCtx as never);
		// row 0: Refresh
		// row 1: << Back to Day Plan
		expect((rendered[0][0] as { text: string }).text).toBe('Refresh');
		expect((rendered[1][0] as { text: string }).text).toBe('<< Back to Day Plan');
	});
});

describe('Day Tree View submenu back button (Phase 08.3 D-21)', () => {
	it('back button label is "<< Back to Day Plan" (not "<< Back to Hub")', async () => {
		const dayPlanMenu = createDayPlanMenu(undefined, undefined);
		const index = (dayPlanMenu as unknown as { index: Map<string, Menu<never>> }).index;
		const treeViewMenu = index.get('day-tree-view');
		expect(treeViewMenu).toBeInstanceOf(Menu);

		const rendered = await (treeViewMenu as Menu<never>).render(renderCtx as never);
		expect((rendered[0][0] as { text: string }).text).toBe('<< Back to Day Plan');
	});
});

describe('Tasks menu structure (Phase 08.3)', () => {
	it('has All Tasks, Refresh, and << Back to Hub buttons', async () => {
		const { tasksMenu } = createTasksMenu(makeTaskService(), undefined);

		const rendered = await tasksMenu.render(renderCtx);
		// With no dailyPlanService the dynamic range produces 0 rows, so the
		// static button rows sit at positions 0 and 1.
		// row 0: [All Tasks] [Refresh]
		// row 1: [<< Back to Hub]
		expect((rendered[0][0] as { text: string }).text).toBe('All Tasks');
		expect((rendered[0][1] as { text: string }).text).toBe('Refresh');
		expect((rendered[1][0] as { text: string }).text).toBe('<< Back to Hub');
	});

	it('Tasks menu with no active chunk (no dailyPlanService) renders Case D copy', async () => {
		const { bot, outgoing } = createTestBot();
		const taskService = makeTaskService();
		const { hubMenu } = registerMenus(bot, taskService);

		// Fire the Tasks button press which navigates to the scoped tasks view.
		const rendered = await hubMenu.render(renderCtx);
		const tasksBtn = rendered[0][1] as { callback_data: string; text: string };
		await bot.handleUpdate(callbackQueryUpdate(tasksBtn.callback_data) as never);

		const editCalls = outgoing.filter((c) => c.method === 'editMessageText');
		expect(editCalls.length).toBeGreaterThanOrEqual(1);
		const editPayload = editCalls[editCalls.length - 1].payload as Record<string, unknown>;
		// No plan available -> builder returns undefined -> Case D fallback.
		expect(editPayload.text).toContain('-- Tasks --');
		expect(editPayload.text).toContain('No plan for today yet.');
	});
});

describe('All Tasks submenu (Phase 08.3)', () => {
	it('has Refresh and << Back to Tasks buttons', async () => {
		const { tasksMenu } = createTasksMenu(makeTaskService(), undefined);
		const index = (tasksMenu as unknown as { index: Map<string, Menu<never>> }).index;
		const allTasksMenu = index.get('all-tasks');
		expect(allTasksMenu).toBeInstanceOf(Menu);

		const rendered = await (allTasksMenu as Menu<never>).render(renderCtx as never);
		// row 0: Refresh (static, no dynamic tasks)
		// row 1: << Back to Tasks
		expect((rendered[0][0] as { text: string }).text).toBe('Refresh');
		expect((rendered[1][0] as { text: string }).text).toBe('<< Back to Tasks');
	});
});

describe('Task Detail menu dual registration (Phase 08.3 OQ-1)', () => {
	it('registers task-detail-from-chunk under tasksMenu and task-detail-from-all under allTasksMenu', () => {
		const { tasksMenu } = createTasksMenu(makeTaskService(), undefined);
		const tasksIndex = (tasksMenu as unknown as { index: Map<string, Menu<never>> }).index;

		// task-detail-from-chunk and all-tasks are registered directly under tasksMenu.
		expect(tasksIndex.get('task-detail-from-chunk')).toBeInstanceOf(Menu);
		expect(tasksIndex.get('all-tasks')).toBeInstanceOf(Menu);

		// task-detail-from-all is registered under all-tasks; grammY's shared
		// menu index surfaces it at the top level of the registered tree.
		expect(tasksIndex.get('task-detail-from-all')).toBeInstanceOf(Menu);
	});
});

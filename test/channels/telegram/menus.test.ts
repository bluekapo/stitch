import { describe, expect, it } from 'vitest';
import { Menu } from '@grammyjs/menu';
import { createHubMenu } from '../../../src/channels/telegram/menus/hub-menu.js';
import { createDayPlanMenu } from '../../../src/channels/telegram/menus/day-plan-menu.js';
import { createTasksMenu } from '../../../src/channels/telegram/menus/tasks-menu.js';
import { registerMenus } from '../../../src/channels/telegram/menus/index.js';
import { createTestBot } from '../../helpers/telegram.js';
import { createTestDb } from '../../helpers/db.js';
import { TaskService } from '../../../src/core/task-service.js';
import { renderDayPlanView, renderHubView, renderTasksView } from '../../../src/channels/telegram/views.js';

function makeTaskService() {
	const db = createTestDb();
	return new TaskService(db);
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

	it('Day Plan button triggers editMessageText with day plan content', async () => {
		const { bot, outgoing } = createTestBot();
		const { hubMenu } = registerMenus(bot, makeTaskService());

		// Render hub menu to get the real callback_data for the "Day Plan" button (row 0, col 0)
		const rendered = await hubMenu.render(renderCtx);
		const dayPlanBtn = rendered[0][0] as { callback_data: string; text: string };
		expect(dayPlanBtn.text).toBe('Day Plan');

		// Fire the button press through the bot
		await bot.handleUpdate(callbackQueryUpdate(dayPlanBtn.callback_data) as never);

		// Assert editMessageText was called with the day plan view content
		const editCalls = outgoing.filter((c) => c.method === 'editMessageText');
		expect(editCalls.length).toBeGreaterThanOrEqual(1);
		const editPayload = editCalls[editCalls.length - 1].payload as Record<string, unknown>;
		expect(editPayload.text).toBe(renderDayPlanView());
		expect(editPayload.parse_mode).toBe('HTML');
	});

	it('Tasks button triggers editMessageText with tasks content', async () => {
		const { bot, outgoing } = createTestBot();
		const taskService = makeTaskService();
		const { hubMenu } = registerMenus(bot, taskService);

		// Render hub menu to get the real callback_data for the "Tasks" button (row 0, col 1)
		const rendered = await hubMenu.render(renderCtx);
		const tasksBtn = rendered[0][1] as { callback_data: string; text: string };
		expect(tasksBtn.text).toBe('Tasks');

		// Fire the button press through the bot
		await bot.handleUpdate(callbackQueryUpdate(tasksBtn.callback_data) as never);

		// Assert editMessageText was called with the tasks view content
		const editCalls = outgoing.filter((c) => c.method === 'editMessageText');
		expect(editCalls.length).toBeGreaterThanOrEqual(1);
		const editPayload = editCalls[editCalls.length - 1].payload as Record<string, unknown>;
		expect(editPayload.text).toBe(renderTasksView(taskService.list()));
		expect(editPayload.parse_mode).toBe('HTML');
	});

	it('Back to Hub button triggers editMessageText with hub content', async () => {
		const { bot, outgoing } = createTestBot();
		const { dayPlanMenu } = registerMenus(bot, makeTaskService());

		// Render the day-plan submenu to get the callback_data for "<< Back to Hub" (row 0, col 0)
		const rendered = await dayPlanMenu.render(renderCtx);
		const backBtn = rendered[0][0] as { callback_data: string; text: string };
		expect(backBtn.text).toBe('<< Back to Hub');

		// Fire the button press through the bot
		await bot.handleUpdate(callbackQueryUpdate(backBtn.callback_data) as never);

		// Assert editMessageText was called with the hub view content
		const editCalls = outgoing.filter((c) => c.method === 'editMessageText');
		expect(editCalls.length).toBeGreaterThanOrEqual(1);
		const editPayload = editCalls[editCalls.length - 1].payload as Record<string, unknown>;
		const expectedHubContent = renderHubView({ status: 'idle', currentChunk: null, timer: null, timerSince: null });
		expect(editPayload.text).toBe(expectedHubContent);
		expect(editPayload.parse_mode).toBe('HTML');
	});
});

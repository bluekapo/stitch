import { describe, expect, it } from 'vitest';
import { createBot } from '../../../src/channels/telegram/bot.js';
import {
	renderDayPlanView,
	renderHubView,
	renderTasksView,
} from '../../../src/channels/telegram/views.js';

describe('createBot', () => {
	it('returns a Bot instance with api', () => {
		const bot = createBot({ token: 'fake:token' });
		expect(bot.api).toBeDefined();
	});

	it('allows all users when no allowedUserId is set', async () => {
		const outgoing: Array<{ method: string; payload: unknown }> = [];
		const bot = createBot({ token: 'fake:token' });

		// Provide botInfo to skip getMe call
		bot.botInfo = {
			id: 1,
			is_bot: true,
			first_name: 'TestBot',
			username: 'test_bot',
			can_join_groups: false,
			can_read_all_group_messages: false,
			supports_inline_queries: false,
			can_connect_to_business: false,
			has_main_web_app: false,
		};

		// Intercept outgoing calls
		bot.api.config.use((_prev, method, payload) => {
			outgoing.push({ method, payload });
			return {
				ok: true,
				result: {
					message_id: 1,
					date: 0,
					chat: { id: 42, type: 'private' as const },
				},
			} as never;
		});

		bot.on('message:text', (ctx) => ctx.reply('echo'));

		await bot.handleUpdate({
			update_id: 1,
			message: {
				message_id: 1,
				from: { id: 42, is_bot: false, first_name: 'Anyone' },
				chat: { id: 42, type: 'private' as const },
				date: Math.floor(Date.now() / 1000),
				text: 'hello',
			},
		});

		const sends = outgoing.filter((o) => o.method === 'sendMessage');
		expect(sends.length).toBe(1);
	});

	it('passes updates from the allowed user', async () => {
		const outgoing: Array<{ method: string; payload: unknown }> = [];
		const bot = createBot({ token: 'fake:token', allowedUserId: 999 });

		bot.botInfo = {
			id: 1,
			is_bot: true,
			first_name: 'TestBot',
			username: 'test_bot',
			can_join_groups: false,
			can_read_all_group_messages: false,
			supports_inline_queries: false,
			can_connect_to_business: false,
			has_main_web_app: false,
		};

		bot.api.config.use((_prev, method, payload) => {
			outgoing.push({ method, payload });
			return {
				ok: true,
				result: {
					message_id: 1,
					date: 0,
					chat: { id: 999, type: 'private' as const },
				},
			} as never;
		});

		bot.on('message:text', (ctx) => ctx.reply('echo'));

		await bot.handleUpdate({
			update_id: 2,
			message: {
				message_id: 2,
				from: { id: 999, is_bot: false, first_name: 'Owner' },
				chat: { id: 999, type: 'private' as const },
				date: Math.floor(Date.now() / 1000),
				text: 'hello',
			},
		});

		const sends = outgoing.filter((o) => o.method === 'sendMessage');
		expect(sends.length).toBe(1);
	});

	it('silently drops updates from non-allowed users', async () => {
		const outgoing: Array<{ method: string; payload: unknown }> = [];
		const bot = createBot({ token: 'fake:token', allowedUserId: 999 });

		bot.botInfo = {
			id: 1,
			is_bot: true,
			first_name: 'TestBot',
			username: 'test_bot',
			can_join_groups: false,
			can_read_all_group_messages: false,
			supports_inline_queries: false,
			can_connect_to_business: false,
			has_main_web_app: false,
		};

		bot.api.config.use((_prev, method, payload) => {
			outgoing.push({ method, payload });
			return {
				ok: true,
				result: {
					message_id: 1,
					date: 0,
					chat: { id: 123, type: 'private' as const },
				},
			} as never;
		});

		bot.on('message:text', (ctx) => ctx.reply('echo'));

		await bot.handleUpdate({
			update_id: 3,
			message: {
				message_id: 3,
				from: { id: 123, is_bot: false, first_name: 'Stranger' },
				chat: { id: 123, type: 'private' as const },
				date: Math.floor(Date.now() / 1000),
				text: 'hello',
			},
		});

		const sends = outgoing.filter((o) => o.method === 'sendMessage');
		expect(sends.length).toBe(0);
	});
});

describe('renderHubView', () => {
	it('returns string containing "Stitch Hub" and "Status"', () => {
		const result = renderHubView({
			status: 'idle',
			currentChunk: null,
			timer: null,
		});
		expect(result).toContain('Stitch Hub');
		expect(result).toContain('Status');
	});

	it('renders idle state with correct icon and timer placeholder', () => {
		const result = renderHubView({
			status: 'idle',
			currentChunk: null,
			timer: null,
		});
		expect(result).toContain('Idle');
		expect(result).toContain('--:--:--');
	});
});

describe('renderDayPlanView', () => {
	it('returns string containing "Day Plan" and "No plan for today yet"', () => {
		const result = renderDayPlanView();
		expect(result).toContain('Day Plan');
		expect(result).toContain('No plan for today yet');
	});
});

describe('renderTasksView', () => {
	it('returns string containing "Tasks" and "No tasks yet"', () => {
		const result = renderTasksView();
		expect(result).toContain('Tasks');
		expect(result).toContain('No tasks yet');
	});
});

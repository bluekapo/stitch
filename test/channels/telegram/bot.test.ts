import { describe, expect, it } from 'vitest';
import { createBot } from '../../../src/channels/telegram/bot.js';
import {
	renderDayPlanView,
	renderHubView,
	renderTasksView,
} from '../../../src/channels/telegram/views.js';
import {
	createTestBot,
	fakeCallbackQueryUpdate,
	fakeTextMessageUpdate,
} from '../../helpers/telegram.js';

describe('createBot factory', () => {
	it('returns a Bot instance with api', () => {
		const bot = createBot({ token: 'fake:token' });
		expect(bot.api).toBeDefined();
	});

	it('allows all users when no allowedUserId is set', async () => {
		const outgoing: Array<{ method: string; payload: unknown }> = [];
		const bot = createBot({ token: 'fake:token' });

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

describe('test helpers', () => {
	describe('createTestBot', () => {
		it('returns bot instance and empty outgoing array', () => {
			const { bot, outgoing } = createTestBot();
			expect(bot).toBeDefined();
			expect(bot.api).toBeDefined();
			expect(outgoing).toEqual([]);
		});

		it('outgoing array captures sendMessage calls with method and payload', async () => {
			const { bot, outgoing } = createTestBot();

			bot.on('message:text', (ctx) => ctx.reply('echo'));

			await bot.handleUpdate(
				fakeTextMessageUpdate('hello') as Parameters<
					typeof bot.handleUpdate
				>[0],
			);

			const sends = outgoing.filter((o) => o.method === 'sendMessage');
			expect(sends.length).toBe(1);
			expect(sends[0].method).toBe('sendMessage');
			expect(sends[0].payload).toBeDefined();
		});
	});

	describe('fakeTextMessageUpdate', () => {
		it('creates valid Update object with given text and user ID', () => {
			const update = fakeTextMessageUpdate('test msg', 456) as {
				update_id: number;
				message: {
					text: string;
					from: { id: number };
					chat: { id: number };
				};
			};
			expect(update.update_id).toBeTypeOf('number');
			expect(update.message.text).toBe('test msg');
			expect(update.message.from.id).toBe(456);
			expect(update.message.chat.id).toBe(456);
		});

		it('defaults userId to 123', () => {
			const update = fakeTextMessageUpdate('hi') as {
				message: { from: { id: number } };
			};
			expect(update.message.from.id).toBe(123);
		});
	});

	describe('fakeCallbackQueryUpdate', () => {
		it('creates valid Update object with given callback data', () => {
			const update = fakeCallbackQueryUpdate('menu-action', 789, 42) as {
				update_id: number;
				callback_query: {
					data: string;
					from: { id: number };
					message: { message_id: number };
				};
			};
			expect(update.update_id).toBeTypeOf('number');
			expect(update.callback_query.data).toBe('menu-action');
			expect(update.callback_query.from.id).toBe(789);
			expect(update.callback_query.message.message_id).toBe(42);
		});

		it('defaults userId to 123 and messageId to 1', () => {
			const update = fakeCallbackQueryUpdate('action') as {
				callback_query: {
					from: { id: number };
					message: { message_id: number };
				};
			};
			expect(update.callback_query.from.id).toBe(123);
			expect(update.callback_query.message.message_id).toBe(1);
		});
	});
});

describe('bot with test helpers - user guard integration', () => {
	it('bot with allowedUserId drops messages from wrong user (outgoing stays empty)', async () => {
		const { bot, outgoing } = createTestBot();

		// Install the user guard from createBot's middleware
		const guardedBot = createBot({ token: 'fake:token', allowedUserId: 999 });
		guardedBot.botInfo = bot.botInfo;

		// Use the test bot's API config for interception
		guardedBot.api.config.use((_prev, method, payload) => {
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

		guardedBot.on('message:text', (ctx) => ctx.reply('echo'));

		// Send from wrong user (123, not 999)
		await guardedBot.handleUpdate(
			fakeTextMessageUpdate('hello', 123) as Parameters<
				typeof guardedBot.handleUpdate
			>[0],
		);

		const sends = outgoing.filter((o) => o.method === 'sendMessage');
		expect(sends.length).toBe(0);
	});

	it('bot without allowedUserId processes messages from any user', async () => {
		const { bot, outgoing } = createTestBot();

		bot.on('message:text', (ctx) => ctx.reply('echo'));

		await bot.handleUpdate(
			fakeTextMessageUpdate('hello', 777) as Parameters<
				typeof bot.handleUpdate
			>[0],
		);

		const sends = outgoing.filter((o) => o.method === 'sendMessage');
		expect(sends.length).toBe(1);
	});
});

describe('renderHubView', () => {
	it('returns string containing "Stitch Hub" and "Status"', () => {
		const result = renderHubView({
			status: 'idle',
			currentChunk: null,
			timer: null,
			timerSince: null,
		});
		expect(result).toContain('Stitch Hub');
		expect(result).toContain('Status');
	});

	it('renders idle state with correct icon and timer placeholder', () => {
		const result = renderHubView({
			status: 'idle',
			currentChunk: null,
			timer: null,
			timerSince: null,
		});
		expect(result).toContain('Idle');
		expect(result).toContain('--:--:--');
	});

	it('renders with current chunk and timer when provided', () => {
		const result = renderHubView({
			status: 'running',
			currentChunk: 'Morning duties',
			timer: '00:12:34',
			timerSince: null,
		});
		expect(result).toContain('Running');
		expect(result).toContain('Morning duties');
		expect(result).toContain('00:12:34');
	});
});

describe('renderDayPlanView', () => {
	it('returns string containing "Day Plan" and "No plan for today yet"', () => {
		const result = renderDayPlanView(undefined);
		expect(result).toContain('Day Plan');
		expect(result).toContain('No plan for today yet');
	});

	it('shows day tree hint when no plan exists', () => {
		const result = renderDayPlanView(undefined);
		expect(result).toContain('Set a day tree');
	});
});

describe('renderTasksView', () => {
	it('returns string containing "Tasks" and "No tasks yet" when empty', () => {
		const result = renderTasksView([]);
		expect(result).toContain('Tasks');
		expect(result).toContain('No tasks yet');
	});

	it('produces hint about creating tasks when empty', () => {
		const result = renderTasksView([]);
		expect(result).toContain('Send "add Task name" to create one.');
	});
});

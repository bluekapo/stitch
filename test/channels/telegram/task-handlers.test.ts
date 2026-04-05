import { describe, it, expect, beforeEach } from 'vitest';
import { createTestBot, fakeTextMessageUpdate } from '../../helpers/telegram.js';
import { createTestDb } from '../../helpers/db.js';
import { TaskService } from '../../../src/core/task-service.js';
import { registerTaskHandlers } from '../../../src/channels/telegram/handlers/task-handlers.js';
import type { Bot } from 'grammy';
import type { StitchContext } from '../../../src/channels/telegram/types.js';

describe('task-handlers', () => {
	let bot: Bot<StitchContext>;
	let outgoing: Array<{ method: string; payload: unknown }>;
	let taskService: TaskService;

	beforeEach(async () => {
		const db = createTestDb();
		taskService = new TaskService(db);
		const result = createTestBot();
		bot = result.bot;
		outgoing = result.outgoing;
		registerTaskHandlers(bot, taskService);
		await bot.init();
	});

	function getReplyText(): string {
		const send = outgoing.find((o) => o.method === 'sendMessage');
		return (send?.payload as Record<string, unknown>)?.text as string ?? '';
	}

	// --- add command ---

	it('add creates task and replies with confirmation', async () => {
		await bot.handleUpdate(fakeTextMessageUpdate('add Buy groceries') as never);
		expect(getReplyText()).toContain('Task created: Buy groceries (#1)');
	});

	it('add is case insensitive', async () => {
		await bot.handleUpdate(fakeTextMessageUpdate('ADD Test Task') as never);
		expect(getReplyText()).toContain('Task created: Test Task (#1)');
	});

	it('add with long name returns validation error', async () => {
		const longName = 'x'.repeat(201);
		await bot.handleUpdate(fakeTextMessageUpdate(`add ${longName}`) as never);
		expect(getReplyText()).toContain('Task name must be 1-200 characters.');
	});

	// --- list command ---

	it('list with no tasks shows empty message', async () => {
		await bot.handleUpdate(fakeTextMessageUpdate('list') as never);
		expect(getReplyText()).toContain('No tasks');
	});

	it('list with tasks shows task names', async () => {
		taskService.create({ name: 'My Task' });
		await bot.handleUpdate(fakeTextMessageUpdate('list') as never);
		expect(getReplyText()).toContain('My Task');
	});

	// --- delete command ---

	it('delete removes task and replies with confirmation', async () => {
		taskService.create({ name: 'To Delete' });
		await bot.handleUpdate(fakeTextMessageUpdate('delete 1') as never);
		expect(getReplyText()).toContain('Deleted: To Delete (#1)');
	});

	it('delete essential task returns error', async () => {
		taskService.create({ name: 'Essential', isEssential: true });
		await bot.handleUpdate(fakeTextMessageUpdate('delete 1') as never);
		expect(getReplyText()).toContain('Cannot delete a locked task.');
	});

	// --- start command ---

	it('start begins timer and replies', async () => {
		taskService.create({ name: 'Timed Task' });
		await bot.handleUpdate(fakeTextMessageUpdate('start 1') as never);
		expect(getReplyText()).toContain('Timer started: Timed Task (#1)');
	});

	// --- stop command ---

	it('stop ends timer and shows duration', async () => {
		taskService.create({ name: 'Timed Task' });
		taskService.startTimer(1);
		await bot.handleUpdate(fakeTextMessageUpdate('stop 1') as never);
		const text = getReplyText();
		expect(text).toContain('Timer stopped: Timed Task (#1)');
		// Should contain duration format HH:MM:SS
		expect(text).toMatch(/\d{2}:\d{2}:\d{2}/);
	});

	// --- done command ---

	it('done completes task and replies', async () => {
		taskService.create({ name: 'Finish This' });
		await bot.handleUpdate(fakeTextMessageUpdate('done 1') as never);
		expect(getReplyText()).toContain('Done: Finish This (#1)');
	});

	it('done auto-stops running timer without error', async () => {
		taskService.create({ name: 'Running Task' });
		taskService.startTimer(1);
		await bot.handleUpdate(fakeTextMessageUpdate('done 1') as never);
		const text = getReplyText();
		expect(text).toContain('Done: Running Task (#1)');
		// Verify task is completed and timer stopped
		const task = taskService.getById(1);
		expect(task?.status).toBe('completed');
		expect(task?.timerStartedAt).toBeNull();
	});

	// --- postpone command ---

	it('postpone increments counter and replies', async () => {
		taskService.create({ name: 'Later' });
		await bot.handleUpdate(fakeTextMessageUpdate('postpone 1') as never);
		const text = getReplyText();
		expect(text).toContain('Postponed: Later (#1)');
		expect(text).toContain('1 times total');
	});

	it('postpone essential task returns error', async () => {
		taskService.create({ name: 'Essential', isEssential: true });
		await bot.handleUpdate(fakeTextMessageUpdate('postpone 1') as never);
		expect(getReplyText()).toContain('Cannot postpone a locked task.');
	});

	// --- error cases ---

	it('non-existent task returns error', async () => {
		await bot.handleUpdate(fakeTextMessageUpdate('delete 999') as never);
		expect(getReplyText()).toContain('Task not found.');
	});

	it('start on non-existent task returns error', async () => {
		await bot.handleUpdate(fakeTextMessageUpdate('start 999') as never);
		expect(getReplyText()).toContain('Task not found.');
	});
});

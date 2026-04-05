import type { Bot } from 'grammy';
import type { TaskService } from '../../../core/task-service.js';
import { createTaskSchema } from '../../../types/task.js';
import type { StitchContext } from '../types.js';
import { renderTaskListText, formatDuration } from '../views.js';

export function registerTaskHandlers(bot: Bot<StitchContext>, taskService: TaskService): void {
	// add <name>
	bot.hears(/^add (.+)$/i, async (ctx) => {
		const rawName = ctx.match[1].trim();
		const parsed = createTaskSchema.safeParse({ name: rawName });
		if (!parsed.success) {
			await ctx.reply('Task name must be 1-200 characters.', { parse_mode: 'HTML' });
			return;
		}
		const task = taskService.create(parsed.data);
		await ctx.reply(`Task created: ${task.name} (#${task.id})`, { parse_mode: 'HTML' });
	});

	// add! <name> (essential/locked task)
	bot.hears(/^add! (.+)$/i, async (ctx) => {
		const rawName = ctx.match[1].trim();
		const parsed = createTaskSchema.safeParse({ name: rawName, isEssential: true });
		if (!parsed.success) {
			await ctx.reply('Task name must be 1-200 characters.', { parse_mode: 'HTML' });
			return;
		}
		const task = taskService.create(parsed.data);
		await ctx.reply(`🔒 Essential task created: ${task.name} (#${task.id})`, { parse_mode: 'HTML' });
	});

	// list
	bot.hears(/^list$/i, async (ctx) => {
		const allTasks = taskService.list();
		await ctx.reply(renderTaskListText(allTasks), { parse_mode: 'HTML' });
	});

	// delete <id>
	bot.hears(/^delete (\d+)$/i, async (ctx) => {
		const id = Number(ctx.match[1]);
		if (!id || id <= 0) {
			await ctx.reply('Invalid task ID.');
			return;
		}
		try {
			const task = taskService.getById(id);
			if (!task) {
				await ctx.reply('Task not found.');
				return;
			}
			taskService.delete(id);
			await ctx.reply(`Deleted: ${task.name} (#${task.id})`);
		} catch (err) {
			await ctx.reply((err as Error).message);
		}
	});

	// start <id>
	bot.hears(/^start (\d+)$/i, async (ctx) => {
		const id = Number(ctx.match[1]);
		if (!id || id <= 0) {
			await ctx.reply('Invalid task ID.');
			return;
		}
		try {
			const task = taskService.getById(id);
			if (!task) {
				await ctx.reply('Task not found.');
				return;
			}
			taskService.startTimer(id);
			await ctx.reply(`Timer started: ${task.name} (#${task.id})`);
		} catch (err) {
			await ctx.reply((err as Error).message);
		}
	});

	// stop <id>
	bot.hears(/^stop (\d+)$/i, async (ctx) => {
		const id = Number(ctx.match[1]);
		if (!id || id <= 0) {
			await ctx.reply('Invalid task ID.');
			return;
		}
		try {
			const task = taskService.getById(id);
			if (!task) {
				await ctx.reply('Task not found.');
				return;
			}
			const durationSeconds = taskService.stopTimer(id);
			await ctx.reply(`Timer stopped: ${task.name} (#${task.id}) \u2014 ${formatDuration(durationSeconds)}`);
		} catch (err) {
			await ctx.reply((err as Error).message);
		}
	});

	// done <id>
	bot.hears(/^done (\d+)$/i, async (ctx) => {
		const id = Number(ctx.match[1]);
		if (!id || id <= 0) {
			await ctx.reply('Invalid task ID.');
			return;
		}
		try {
			const task = taskService.getById(id);
			if (!task) {
				await ctx.reply('Task not found.');
				return;
			}
			// Auto-stop timer if running
			if (task.timerStartedAt) {
				taskService.stopTimer(id);
			}
			taskService.update(id, { status: 'completed' });
			await ctx.reply(`Done: ${task.name} (#${task.id})`);
		} catch (err) {
			await ctx.reply((err as Error).message);
		}
	});

	// postpone <id>
	bot.hears(/^postpone (\d+)$/i, async (ctx) => {
		const id = Number(ctx.match[1]);
		if (!id || id <= 0) {
			await ctx.reply('Invalid task ID.');
			return;
		}
		try {
			taskService.postpone(id);
			const updated = taskService.getById(id);
			await ctx.reply(`Postponed: ${updated!.name} (#${id}) \u2014 ${updated!.postponeCount} times total`);
		} catch (err) {
			await ctx.reply((err as Error).message);
		}
	});
}

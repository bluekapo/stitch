import type { Bot } from 'grammy';
import type { TaskParserService } from '../../../core/task-parser.js';
import type { TaskService } from '../../../core/task-service.js';
import type { StitchContext } from '../types.js';

export function registerNlHandler(
	bot: Bot<StitchContext>,
	parser: TaskParserService,
	taskService: TaskService,
): void {
	bot.on('message:text', async (ctx, next) => {
		const text = ctx.message.text;
		// Skip slash commands -- let them fall through
		if (text.startsWith('/')) return next();

		try {
			const parsed = await parser.parse(text);
			// Only pass recurrenceDay for weekly tasks — LLM sometimes sets it spuriously
			const recurrenceDay = parsed.taskType === 'weekly' ? parsed.recurrenceDay : undefined;
			const task = taskService.create({
				name: parsed.name,
				description: parsed.description,
				isEssential: parsed.isEssential,
				taskType: parsed.taskType,
				deadline: parsed.deadline,
				recurrenceDay,
			});
			let reply = `Task created: ${task.name} (#${task.id})`;
			if (parsed.taskType !== 'ad-hoc') reply += `\nType: ${parsed.taskType}`;
			if (parsed.deadline) reply += `\nDeadline: ${parsed.deadline}`;
			if (recurrenceDay !== undefined) reply += `\nRecurs: day ${recurrenceDay}`;
			await ctx.reply(reply);
		} catch {
			await ctx.reply('Could not parse that as a task. Try again or use "add <name>".');
		}
	});
}

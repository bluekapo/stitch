import type { Bot } from 'grammy';
import type { DayTreeService } from '../../../core/day-tree-service.js';
import type { StitchDb } from '../../../db/index.js';
import type { SttProvider } from '../../../providers/stt.js';
import type { TaskParserService } from '../../../core/task-parser.js';
import type { TaskService } from '../../../core/task-service.js';
import { scheduleCleanup } from '../cleanup.js';
import type { StitchContext } from '../types.js';
import { routeTextInput } from './text-router.js';

export function registerVoiceHandler(
	bot: Bot<StitchContext>,
	sttProvider: SttProvider,
	taskService: TaskService,
	parser: TaskParserService,
	botToken: string,
	dayTreeService?: DayTreeService,
	db?: StitchDb,
): void {
	bot.on('message:voice', async (ctx) => {
		const chatId = ctx.chat.id;
		const voiceMsgId = ctx.message.message_id;

		let transcribedText: string;
		try {
			// Get file info from Telegram
			const file = await ctx.getFile();
			if (!file.file_path) {
				const reply = await ctx.reply('Could not access voice message.');
				scheduleCleanup(ctx, chatId, voiceMsgId, reply.message_id, db);
				return;
			}

			// Download the audio file
			const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
			const response = await fetch(downloadUrl);
			if (!response.ok) {
				const reply = await ctx.reply('Voice transcription failed. Please try again or type your message.');
				scheduleCleanup(ctx, chatId, voiceMsgId, reply.message_id, db);
				return;
			}
			const audioBuffer = Buffer.from(await response.arrayBuffer());

			// Transcribe via STT provider
			const result = await sttProvider.transcribe(audioBuffer, 'audio/ogg');
			transcribedText = result.text.trim();
		} catch {
			const reply = await ctx.reply('Voice transcription failed. Please try again or type your message.');
			scheduleCleanup(ctx, chatId, voiceMsgId, reply.message_id, db);
			return;
		}

		// Empty transcription
		if (!transcribedText) {
			const reply = await ctx.reply('Could not understand the voice message.');
			scheduleCleanup(ctx, chatId, voiceMsgId, reply.message_id, db);
			return;
		}

		// Route through shared text processing
		const result = await routeTextInput(transcribedText, { taskService, parser, dayTreeService });
		if (result.reply) {
			const reply = await ctx.reply(result.reply);
			scheduleCleanup(ctx, chatId, voiceMsgId, reply.message_id, db);
		} else {
			// No reply (e.g., slash command -- unlikely from voice but handle gracefully)
			scheduleCleanup(ctx, chatId, voiceMsgId, undefined, db);
		}
	});
}

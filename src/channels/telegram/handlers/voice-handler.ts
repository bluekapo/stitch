import type { Bot } from 'grammy';
import type { CheckInService } from '../../../core/check-in-service.js';
import type { DailyPlanService } from '../../../core/daily-plan-service.js';
import type { DayTreeService } from '../../../core/day-tree-service.js';
import type { IntentClassifierService } from '../../../core/intent-classifier.js';
import type { TaskParserService } from '../../../core/task-parser.js';
import type { TaskService } from '../../../core/task-service.js';
import type { StitchDb } from '../../../db/index.js';
import type { SttProvider } from '../../../providers/stt.js';
import { scheduleCleanup } from '../cleanup.js';
import type { StitchContext } from '../types.js';
import { routeTextInput } from './text-router.js';

/**
 * Options for registerVoiceHandler.
 *
 * Phase 08.4 (Pitfall 5): converted from 8 positional parameters to a single
 * options object to eliminate positional drift bugs as the dependency surface
 * grows. Optional fields stay optional via field-level `?` markers — same
 * back-compat semantics as the old positional defaults.
 */
export interface VoiceHandlerOptions {
	bot: Bot<StitchContext>;
	sttProvider: SttProvider;
	taskService: TaskService;
	parser: TaskParserService;
	botToken: string;
	dayTreeService?: DayTreeService;
	db?: StitchDb;
	dailyPlanService?: DailyPlanService;
	intentClassifierService?: IntentClassifierService;
	// Phase 9 (D-05.4): passed through to routeTextInput so task mutations
	// fire forceCheckIn('task_action').
	checkInService?: CheckInService;
}

export function registerVoiceHandler(options: VoiceHandlerOptions): void {
	const {
		bot,
		sttProvider,
		taskService,
		parser,
		botToken,
		dayTreeService,
		db,
		dailyPlanService,
		intentClassifierService,
		checkInService,
	} = options;

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

		// Route through shared text processing.
		// Phase 08.4 D-18: voice does NOT call intentClassifierService.classify
		// directly. It delegates to routeTextInput which performs the classifier
		// dispatch (or the explicit fast-path bypass) once per request. This
		// keeps voice and text on a single shared code path.
		const result = await routeTextInput(transcribedText, {
			taskService,
			parser,
			dayTreeService,
			dailyPlanService,
			intentClassifierService,
			checkInService, // Phase 9 D-05.4: forced check-in on task mutations
			db, // Phase 10 D-18: prediction lookup for completion diff
		});
		if (result.reply) {
			const reply = await ctx.reply(result.reply);
			scheduleCleanup(ctx, chatId, voiceMsgId, reply.message_id, db);
		} else {
			// No reply (e.g., slash command -- unlikely from voice but handle gracefully)
			scheduleCleanup(ctx, chatId, voiceMsgId, undefined, db);
		}
	});
}

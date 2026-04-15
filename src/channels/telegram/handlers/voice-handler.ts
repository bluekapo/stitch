import type { Bot } from 'grammy';
import pino, { type Logger } from 'pino';
import type { CheckInService } from '../../../core/check-in-service.js';
import type { DailyPlanService } from '../../../core/daily-plan-service.js';
import type { DayTreeService } from '../../../core/day-tree-service.js';
import type { IntentClassifierService } from '../../../core/intent-classifier.js';
import { reqId } from '../../../core/logger.js';
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
 *
 * Phase 12 (D-07, D-11, D-20): `logger` is optional for backward compat with
 * legacy voice-handler tests that don't wire one. Production wiring
 * (src/channels/telegram/index.ts) ALWAYS passes a tagged channel logger so
 * every voice interaction gets a `req_id` + `source: 'telegram_voice'` child
 * logger threaded through to routeTextInput. When absent, we fall back to a
 * silent pino so `log.debug/.warn/.error` calls remain valid no-ops.
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
	// Phase 12 (D-11, D-20): pino logger for the voice entry point. Optional
	// for backward compat with existing tests; production wiring in
	// src/channels/telegram/index.ts always passes a real child logger.
	logger?: Logger;
}

// Phase 12 (D-11): silent fallback so the handler never crashes on a missing
// logger in legacy test wiring.
const silentLogger: Logger = pino({ level: 'silent' });

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

	const baseLogger = options.logger ?? silentLogger;

	bot.on('message:voice', async (ctx) => {
		// Phase 12 (D-07, D-11): per-interaction req_id + source tag so the voice
		// entry point logs, the STT latency log, the classifier log, and the
		// downstream service mutation log all share one correlation id. Pitfall 8:
		// voice + text + hub buttons all synthesize their own req_id at the edge.
		const reqLogger = baseLogger.child({
			req_id: reqId(),
			source: 'telegram_voice',
			userId: ctx.from?.id,
		});

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
				reqLogger.warn(
					{ status: response.status, statusText: response.statusText },
					'voice:download-failed',
				);
				const reply = await ctx.reply(
					'Voice transcription failed. Please try again or type your message.',
				);
				scheduleCleanup(ctx, chatId, voiceMsgId, reply.message_id, db);
				return;
			}
			const audioBuffer = Buffer.from(await response.arrayBuffer());

			// Transcribe via STT provider.
			// D-07: record STT latency so the trace for this req_id includes the
			// transcription cost alongside the classifier cost downstream.
			const sttStarted = Date.now();
			const result = await sttProvider.transcribe(audioBuffer, 'audio/ogg');
			transcribedText = result.text.trim();
			reqLogger.debug(
				{ latency_ms: Date.now() - sttStarted, text_length: transcribedText.length },
				'stt:done',
			);
		} catch (err) {
			reqLogger.error({ err: (err as Error).message }, 'voice:transcribe-failed');
			const reply = await ctx.reply(
				'Voice transcription failed. Please try again or type your message.',
			);
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
		// Phase 12 (D-11): pass reqLogger so the downstream classifier + service
		// calls inherit this voice request's correlation id.
		const result = await routeTextInput(
			transcribedText,
			{
				taskService,
				parser,
				dayTreeService,
				dailyPlanService,
				intentClassifierService,
				checkInService, // Phase 9 D-05.4: forced check-in on task mutations
				db, // Phase 10 D-18: prediction lookup for completion diff
				logger: baseLogger,
			},
			reqLogger,
		);
		if (result.reply) {
			const reply = await ctx.reply(result.reply);
			scheduleCleanup(ctx, chatId, voiceMsgId, reply.message_id, db);
		} else {
			// No reply (e.g., slash command -- unlikely from voice but handle gracefully)
			scheduleCleanup(ctx, chatId, voiceMsgId, undefined, db);
		}
	});
}

import type { Bot } from 'grammy';
import type { AppConfig } from '../../config.js';
import type { CheckInService } from '../../core/check-in-service.js';
import type { DailyPlanService } from '../../core/daily-plan-service.js';
import type { DayTreeService } from '../../core/day-tree-service.js';
import type { IntentClassifierService } from '../../core/intent-classifier.js';
import { TaskParserService } from '../../core/task-parser.js';
import type { TaskService } from '../../core/task-service.js';
import type { StitchDb } from '../../db/index.js';
import type { LlmProvider } from '../../providers/llm.js';
import type { SttProvider } from '../../providers/stt.js';
import { createBot } from './bot.js';
import { scheduleCleanup } from './cleanup.js';
import { registerVoiceHandler } from './handlers/voice-handler.js';
import { routeTextInput } from './handlers/text-router.js';
import { HubManager } from './hub.js';
import { registerMenus } from './menus/index.js';
import type { StitchContext } from './types.js';
import { renderHubView } from './views.js';

export interface TelegramChannel {
	bot: Bot<StitchContext>;
	hub: HubManager;
}

export interface TelegramSetupOptions {
	config: AppConfig;
	taskService: TaskService;
	llmProvider: LlmProvider;
	db?: StitchDb;
	dayTreeService?: DayTreeService;
	dailyPlanService?: DailyPlanService;
	sttProvider?: SttProvider;
	intentClassifierService?: IntentClassifierService;
	// Phase 9 (D-05.4): handlers fire forceCheckIn('task_action') after task
	// mutations. Optional so existing tests and non-check-in-service paths
	// continue to work.
	checkInService?: CheckInService;
}

export function setupTelegramBot(options: TelegramSetupOptions): TelegramChannel {
	const {
		config,
		taskService,
		llmProvider,
		db,
		dayTreeService,
		dailyPlanService,
		sttProvider,
		intentClassifierService,
	} = options;

	const bot = createBot({
		token: config.TELEGRAM_BOT_TOKEN,
		allowedUserId: config.TELEGRAM_ALLOWED_USER_ID,
	});

	const hub = new HubManager(bot.api);
	const { hubMenu } = registerMenus(bot, taskService, dailyPlanService, dayTreeService);

	// /start command: send or refresh hub
	bot.command('start', async (ctx) => {
		// Delete the /start message itself
		try {
			await ctx.deleteMessage();
		} catch {
			// May fail if message is already deleted
		}

		const chatId = ctx.chat.id;
		const text = renderHubView({ status: 'idle', currentChunk: null, timer: null, timerSince: null });
		await hub.sendHub(chatId, text, hubMenu, ctx);
	});

	const parser = new TaskParserService(llmProvider);

	// Voice handler: transcribe → routeTextInput → cleanup.
	// Phase 08.4 Pitfall 5: registerVoiceHandler now takes an options object.
	if (sttProvider) {
		registerVoiceHandler({
			bot,
			sttProvider,
			taskService,
			parser,
			botToken: config.TELEGRAM_BOT_TOKEN,
			dayTreeService,
			db,
			dailyPlanService,
			intentClassifierService,
		});
	}

	// Unified text handler: routeTextInput handles all commands + classifier dispatch
	bot.on('message:text', async (ctx) => {
		const text = ctx.message.text;
		if (text.startsWith('/')) return; // Let command handlers process
		const chatId = ctx.chat.id;
		const userMsgId = ctx.message.message_id;
		const result = await routeTextInput(text, {
			taskService,
			parser,
			dayTreeService,
			dailyPlanService,
			intentClassifierService,
		});
		if (result.reply) {
			const reply = await ctx.reply(result.reply, { parse_mode: 'HTML' });
			scheduleCleanup(ctx, chatId, userMsgId, reply.message_id, db);
		}
	});

	return { bot, hub };
}

export type { HubRef } from './hub.js';
export { HubManager } from './hub.js';
export type { StitchContext } from './types.js';

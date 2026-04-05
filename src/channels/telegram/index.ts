import type { Bot } from 'grammy';
import type { AppConfig } from '../../config.js';
import type { BlueprintService } from '../../core/blueprint-service.js';
import type { DailyPlanService } from '../../core/daily-plan-service.js';
import { TaskParserService } from '../../core/task-parser.js';
import type { TaskService } from '../../core/task-service.js';
import type { LlmProvider } from '../../providers/llm.js';
import type { SttProvider } from '../../providers/stt.js';
import { createBot } from './bot.js';
import { autoCleanup } from './cleanup.js';
import { registerBlueprintHandlers } from './handlers/blueprint-handler.js';
import { registerNlHandler } from './handlers/nl-handler.js';
import { registerTaskHandlers } from './handlers/task-handlers.js';
import { registerVoiceHandler } from './handlers/voice-handler.js';
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
	blueprintService?: BlueprintService;
	dailyPlanService?: DailyPlanService;
	sttProvider?: SttProvider;
}

export function setupTelegramBot(options: TelegramSetupOptions): TelegramChannel {
	const { config, taskService, llmProvider, blueprintService, dailyPlanService, sttProvider } = options;

	const bot = createBot({
		token: config.TELEGRAM_BOT_TOKEN,
		allowedUserId: config.TELEGRAM_ALLOWED_USER_ID,
	});

	const hub = new HubManager(bot.api);
	const { hubMenu } = registerMenus(bot, taskService, dailyPlanService);

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

	// Text command handlers (registered AFTER /start, BEFORE autoCleanup per Pitfall 1)
	registerTaskHandlers(bot, taskService);

	// Blueprint handlers (registered AFTER task handlers, BEFORE NL catch-all)
	if (blueprintService) {
		registerBlueprintHandlers(bot, blueprintService);
	}

	// Parser shared by voice and NL handlers
	const parser = new TaskParserService(llmProvider);

	// Voice handler: registered AFTER blueprint handlers, BEFORE NL catch-all
	if (sttProvider) {
		registerVoiceHandler(bot, sttProvider, taskService, parser, config.TELEGRAM_BOT_TOKEN);
	}

	// NL handler: catch-all for unmatched text, parses via LLM (registered AFTER task/voice handlers)
	registerNlHandler(bot, parser, taskService);

	// Auto-cleanup for text messages (catch-all, registered LAST per Pitfall 1 & 6)
	bot.on('message:text', autoCleanup);

	return { bot, hub };
}

export type { HubRef } from './hub.js';
export { HubManager } from './hub.js';
export type { StitchContext } from './types.js';

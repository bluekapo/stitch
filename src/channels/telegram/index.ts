import type { Bot } from 'grammy';
import type { AppConfig } from '../../config.js';
import type { TaskService } from '../../core/task-service.js';
import { createBot } from './bot.js';
import { autoCleanup } from './cleanup.js';
import { registerTaskHandlers } from './handlers/task-handlers.js';
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
}

export function setupTelegramBot(options: TelegramSetupOptions): TelegramChannel {
	const { config, taskService } = options;

	const bot = createBot({
		token: config.TELEGRAM_BOT_TOKEN,
		allowedUserId: config.TELEGRAM_ALLOWED_USER_ID,
	});

	const hub = new HubManager(bot.api);
	const { hubMenu } = registerMenus(bot, taskService);

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
		await hub.sendHub(chatId, text, hubMenu);
	});

	// Text command handlers (registered AFTER /start, BEFORE autoCleanup per Pitfall 1)
	registerTaskHandlers(bot, taskService);

	// Auto-cleanup for text messages (catch-all, registered LAST per Pitfall 1 & 6)
	bot.on('message:text', autoCleanup);

	return { bot, hub };
}

export type { HubRef } from './hub.js';
export { HubManager } from './hub.js';
export type { StitchContext } from './types.js';

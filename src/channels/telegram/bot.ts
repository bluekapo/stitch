import { autoRetry } from '@grammyjs/auto-retry';
import { Bot } from 'grammy';
import type { StitchContext } from './types.js';

export interface TelegramBotOptions {
	token: string;
	allowedUserId?: number;
}

export function createBot(options: TelegramBotOptions): Bot<StitchContext> {
	const bot = new Bot<StitchContext>(options.token);

	bot.api.config.use(autoRetry());

	if (options.allowedUserId) {
		bot.use(async (ctx, next) => {
			if (ctx.from?.id === options.allowedUserId) {
				await next();
			}
			// Silently ignore other users
		});
	}

	bot.catch((err) => {
		console.error('Telegram bot error:', err);
	});

	return bot;
}

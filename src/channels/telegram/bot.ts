import { autoRetry } from '@grammyjs/auto-retry';
import { Bot } from 'grammy';
import pino, { type Logger } from 'pino';
import type { StitchContext } from './types.js';

export interface TelegramBotOptions {
	token: string;
	allowedUserId?: number;
	// Phase 12 (D-20): injected logger. Optional for backward compat with bot
	// unit tests that don't wire a logger; production wiring in src/app.ts
	// always passes `rootLogger.child({ service: 'telegram' })`. When absent
	// we default to a silent pino so `bot.catch` handlers emit zero stdout
	// writes — the whole point of D-20.
	logger?: Logger;
}

export function createBot(options: TelegramBotOptions): Bot<StitchContext> {
	const bot = new Bot<StitchContext>(options.token);
	const log = options.logger ?? pino({ level: 'silent' });

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
		// D-20: structured logging via the injected pino child. Replaces the
		// last stdout error-sink in the telegram channel tree.
		log.error({ err }, 'telegram:bot-error');
	});

	return bot;
}

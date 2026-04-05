import type { Bot } from 'grammy';
import { buildApp } from './app.js';
import type { StitchContext } from './channels/telegram/types.js';
import { loadConfig } from './config.js';
import type { RecurrenceScheduler } from './core/recurrence-scheduler.js';

const config = loadConfig();
const app = buildApp({ config });

const shutdown = async (signal: string) => {
	app.log.info(`Received ${signal}, shutting down...`);
	const bot = (app as unknown as { bot?: Bot<StitchContext> }).bot;
	if (bot) {
		await bot.stop();
	}
	const scheduler = (app as unknown as { scheduler?: RecurrenceScheduler }).scheduler;
	if (scheduler) {
		scheduler.stop();
	}
	await app.close();
	process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

try {
	const address = await app.listen({ port: config.PORT, host: '0.0.0.0' });
	app.log.info(`Stitch server listening at ${address}`);

	// Start Telegram bot long polling (non-blocking -- do NOT await, Pitfall 7)
	const bot = (app as unknown as { bot?: Bot<StitchContext> }).bot;
	if (bot) {
		bot.start({
			onStart: () => {
				app.log.info('Telegram bot started (long polling)');
			},
		});
	}
} catch (err) {
	app.log.error(err);
	process.exit(1);
}

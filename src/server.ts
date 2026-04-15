import fs from 'node:fs';
import path from 'node:path';
import type { Bot } from 'grammy';
import { buildApp } from './app.js';
import type { StitchContext } from './channels/telegram/types.js';
import { loadConfig } from './config.js';
import type { RecurrenceScheduler } from './core/recurrence-scheduler.js';

const config = loadConfig();
const app = buildApp({ config });

const shutdown = async (signal: string) => {
	// D-01 Windows diagnostic: sync sentinel proves the handler fired even if
	// the pino transport worker dies before flush or the parent force-kills us.
	// `app.log.info` below goes through an async worker thread — on Windows
	// under `node --watch`, the parent calls `child.kill()` which is always
	// SIGKILL-equivalent regardless of the signal arg, so async output is
	// frequently lost mid-write.
	try {
		const sentinelPath = path.join(path.resolve(config.LOG_DIR), 'shutdown-sentinel.txt');
		fs.writeFileSync(sentinelPath, `${new Date().toISOString()} ${signal} pid=${process.pid}\n`, {
			flag: 'a',
		});
		process.stderr.write(`[shutdown] ${signal} fired (pid=${process.pid})\n`);
	} catch {
		// best-effort — never block shutdown on sentinel write
	}

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
// D-01 Windows: Ctrl+Break on Windows delivers SIGBREAK; also catch it so the
// rotate-on-exit path fires even when Ctrl+C is intercepted by a shell layer.
process.on('SIGBREAK' as NodeJS.Signals, () => shutdown('SIGBREAK'));

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

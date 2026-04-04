import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = buildApp({ config });

const shutdown = async (signal: string) => {
	app.log.info(`Received ${signal}, shutting down...`);
	await app.close();
	process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

try {
	const address = await app.listen({ port: config.PORT, host: '0.0.0.0' });
	app.log.info(`Stitch server listening at ${address}`);
} catch (err) {
	app.log.error(err);
	process.exit(1);
}

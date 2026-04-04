import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { type AppConfig, loadConfig } from './config.js';
import { healthRoutes } from './routes/health.js';

export interface AppOptions {
	config?: AppConfig;
}

export function buildApp(options: AppOptions = {}): FastifyInstance {
	const config = options.config ?? loadConfig();

	const app = Fastify({
		logger: {
			level: config.LOG_LEVEL,
		},
	});

	// Decorate app with config for access in routes/plugins
	app.decorate('config', config);

	app.register(healthRoutes);

	return app;
}

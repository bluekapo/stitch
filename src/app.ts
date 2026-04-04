import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { type AppConfig, loadConfig } from './config.js';
import { createDb, type StitchDb } from './db/index.js';
import { createLlmProvider } from './providers/index.js';
import type { LlmProvider } from './providers/llm.js';
import { healthRoutes } from './routes/health.js';

export interface AppOptions {
	config?: AppConfig;
	llmProvider?: LlmProvider;
	db?: StitchDb;
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

	// Create and decorate LLM provider
	const llmProvider = options.llmProvider ?? createLlmProvider(config);
	app.decorate('llmProvider', llmProvider);

	// Database
	const db = options.db ?? createDb(config.DATABASE_URL);
	app.decorate('db', db);

	app.register(healthRoutes);

	// Health check on startup -- log warning if LLM unavailable but do NOT crash
	app.addHook('onReady', async () => {
		const health = await llmProvider.healthCheck();
		if (health.ok) {
			app.log.info('LLM provider health check passed');
		} else {
			// Per INFRA-05: Log clear warning but do NOT crash
			app.log.warn(
				`LLM provider unavailable: ${health.error}. App will still serve but LLM calls will fail.`,
			);
		}
	});

	return app;
}

import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { type AppConfig, loadConfig } from './config.js';
import { createLlmProvider, createSttProvider } from './providers/index.js';
import type { LlmProvider } from './providers/llm.js';
import type { SttProvider } from './providers/stt.js';
import { healthRoutes } from './routes/health.js';

export interface AppOptions {
	config?: AppConfig;
	llmProvider?: LlmProvider;
	sttProvider?: SttProvider;
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

	// Create and decorate STT provider
	const sttProvider = options.sttProvider ?? createSttProvider(config);
	app.decorate('sttProvider', sttProvider);

	app.register(healthRoutes);

	// Health check on startup -- log warning if providers unavailable but do NOT crash
	app.addHook('onReady', async () => {
		const llmHealth = await llmProvider.healthCheck();
		if (llmHealth.ok) {
			app.log.info('LLM provider health check passed');
		} else {
			// Per INFRA-05: Log clear warning but do NOT crash
			app.log.warn(
				`LLM provider unavailable: ${llmHealth.error}. App will still serve but LLM calls will fail.`,
			);
		}

		const sttHealth = await sttProvider.healthCheck();
		if (sttHealth.ok) {
			app.log.info('STT provider health check passed');
		} else {
			app.log.warn(
				`STT provider unavailable: ${sttHealth.error}. App will still serve but STT calls will fail.`,
			);
		}
	});

	return app;
}

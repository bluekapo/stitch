import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import type { Bot } from 'grammy';
import { setupTelegramBot } from './channels/telegram/index.js';
import { DailyPlanService } from './core/daily-plan-service.js';
import { DayTreeService } from './core/day-tree-service.js';
import type { StitchContext } from './channels/telegram/types.js';
import { type AppConfig, loadConfig } from './config.js';
import { RecurrenceScheduler } from './core/recurrence-scheduler.js';
import { TaskService } from './core/task-service.js';
import { createDb, type StitchDb } from './db/index.js';
import { createLlmProvider, createSttProvider } from './providers/index.js';
import type { LlmProvider } from './providers/llm.js';
import type { SttProvider } from './providers/stt.js';
import { healthRoutes } from './routes/health.js';

export interface AppOptions {
	config?: AppConfig;
	llmProvider?: LlmProvider;
	sttProvider?: SttProvider;
	db?: StitchDb;
	telegramBot?: Bot<StitchContext>;
}

export function buildApp(options: AppOptions = {}): FastifyInstance {
	const config = options.config ?? loadConfig();

	const app = Fastify({
		logger: {
			level: config.LOG_LEVEL,
		},
		pluginTimeout: 120_000,
	});

	// Decorate app with config for access in routes/plugins
	app.decorate('config', config);

	// Create and decorate LLM provider
	const llmProvider = options.llmProvider ?? createLlmProvider(config);
	app.decorate('llmProvider', llmProvider);

	// Database
	const db = options.db ?? createDb(config.DATABASE_URL);
	app.decorate('db', db);

	// Create and decorate STT provider
	const sttProvider = options.sttProvider ?? createSttProvider(config);
	app.decorate('sttProvider', sttProvider);

	// Task service
	const taskService = new TaskService(db);
	app.decorate('taskService', taskService);

	// Day tree service
	const dayTreeService = new DayTreeService(db, llmProvider);
	app.decorate('dayTreeService', dayTreeService);

	// Daily plan service
	const dailyPlanService = new DailyPlanService(db, dayTreeService, taskService, llmProvider);
	app.decorate('dailyPlanService', dailyPlanService);

	// Recurrence scheduler
	const scheduler = new RecurrenceScheduler(taskService, config.RECURRENCE_CRON_TIME);
	app.decorate('scheduler', scheduler);

	// Telegram bot
	if (options.telegramBot) {
		app.decorate('bot', options.telegramBot);
	} else if (config.TELEGRAM_BOT_TOKEN) {
		const { bot, hub } = setupTelegramBot({ config, taskService, llmProvider, dayTreeService, dailyPlanService, sttProvider });
		app.decorate('bot', bot);
		app.decorate('hub', hub);
	}

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

		// Start recurrence scheduler and generate any missed tasks for today
		scheduler.start();
		app.log.info(`Recurrence scheduler started (cron: ${config.RECURRENCE_CRON_TIME})`);
		scheduler.generateAll();

		// Generate today's plan if none exists (PLAN-08)
		try {
			const plan = await dailyPlanService.ensureTodayPlan();
			if (plan) {
				app.log.info(`Daily plan generated for today: ${dailyPlanService.getPlanWithChunks(plan.id).chunks.length} chunks`);
			} else {
				app.log.info('No daily plan generated (already exists or no day tree set)');
			}
		} catch (err) {
			app.log.warn({ err }, 'Failed to generate daily plan on startup');
		}
	});

	// Stop scheduler on app close
	app.addHook('onClose', async () => {
		scheduler.stop();
	});

	return app;
}

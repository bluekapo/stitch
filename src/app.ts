import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import type { Bot } from 'grammy';
import { setupTelegramBot } from './channels/telegram/index.js';
import { flushPendingCleanups } from './channels/telegram/cleanup.js';
import { CheckInService } from './core/check-in-service.js';
import { DailyPlanService } from './core/daily-plan-service.js';
import { DayTreeService } from './core/day-tree-service.js';
import { IntentClassifierService } from './core/intent-classifier.js';
import { PredictionService } from './core/prediction-service.js';
import { WakeStateService } from './core/wake-state.js';
import type { StitchContext } from './channels/telegram/types.js';
import { type AppConfig, loadConfig } from './config.js';
import { RecurrenceScheduler } from './core/recurrence-scheduler.js';
import { TaskService } from './core/task-service.js';
import { createDb, type StitchDb } from './db/index.js';
import { createLlmProvider, createSttProvider } from './providers/index.js';
import type { LlmProvider } from './providers/llm.js';
import type { SttProvider } from './providers/stt.js';
import { healthRoutes } from './routes/health.js';
import { wakeRoutes } from './routes/wake.js';

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

	// Phase 10 (D-01): PredictionService — the "predict" half of predict-then-plan.
	// Constructed BEFORE DailyPlanService because DailyPlanService depends on it.
	// NO dailyPlanService dependency in the other direction (Pitfall 5 cycle guard).
	const predictionService = new PredictionService(
		db,
		taskService,
		dayTreeService,
		llmProvider,
		// Fastify's logger is structurally compatible with pino's Logger interface
		// but TypeScript considers them distinct. Cast is safe — same pattern used
		// for CheckInService/WakeStateService below.
		app.log as unknown as import('pino').Logger,
	);
	app.decorate('predictionService', predictionService);

	// Daily plan service — Phase 10 adds predictionService as the 5th parameter
	// so generatePlan can run predict-then-plan (PHASE 1.5 before PHASE 2).
	const dailyPlanService = new DailyPlanService(
		db,
		dayTreeService,
		taskService,
		llmProvider,
		predictionService,
	);
	app.decorate('dailyPlanService', dailyPlanService);

	// Intent classifier service (Phase 08.4)
	const intentClassifierService = new IntentClassifierService(
		llmProvider,
		dayTreeService,
		taskService,
		dailyPlanService,
	);
	app.decorate('intentClassifierService', intentClassifierService);

	// Phase 9 (PLAN-05/06): CheckInService -- long-running ticker for chunk
	// lifecycle + LLM oracle. Constructed BEFORE the Telegram bot because the
	// bot wiring below threads checkInService into handlers for D-05.4. Bot
	// + HubManager are late-bound via setBot/setHubManager after setupTelegramBot.
	const checkInService = new CheckInService({
		llmProvider,
		dayTreeService,
		taskService,
		dailyPlanService,
		db,
		userChatId: config.TELEGRAM_ALLOWED_USER_ID,
		tickIntervalMs: config.NUDGE_TICK_INTERVAL_MS,
		cleanupTtlMs: config.CHECKIN_CLEANUP_MS,
		// Fastify's logger is structurally compatible with pino's Logger interface
		// but TypeScript considers them distinct (FastifyBaseLogger vs Logger).
		// Cast is safe: both expose .info/.warn/.error/.debug/.trace with the
		// same call signatures, which is all CheckInService/WakeStateService use.
		logger: app.log as unknown as import('pino').Logger,
	});
	app.decorate('checkInService', checkInService);

	// Recurrence scheduler
	const scheduler = new RecurrenceScheduler(taskService, config.RECURRENCE_CRON_TIME);
	app.decorate('scheduler', scheduler);

	// Telegram bot
	if (options.telegramBot) {
		app.decorate('bot', options.telegramBot);
	} else if (config.TELEGRAM_BOT_TOKEN) {
		const { bot, hub } = setupTelegramBot({
			config,
			taskService,
			llmProvider,
			db,
			dayTreeService,
			dailyPlanService,
			sttProvider,
			intentClassifierService,
			checkInService, // Phase 9 (D-05.4): handlers fire forceCheckIn('task_action')
		});
		app.decorate('bot', bot);
		app.decorate('hub', hub);

		// Phase 9: late-bind bot + hub to checkInService (constructor ran before
		// the Telegram bot existed). See CheckInService.setBot/setHubManager.
		checkInService.setBot(bot);
		checkInService.setHubManager(hub);
	}

	// Phase 9 (CHAN-02/03): WakeStateService -- request-driven, started by the
	// POST /wake/:secret route.
	const wakeStateService = new WakeStateService({
		db,
		dailyPlanService,
		dayTreeService,
		checkInService,
		debounceMs: config.WAKE_DEBOUNCE_MS,
		// Fastify's logger is structurally compatible with pino's Logger interface
		// but TypeScript considers them distinct (FastifyBaseLogger vs Logger).
		// Cast is safe: both expose .info/.warn/.error/.debug/.trace with the
		// same call signatures, which is all CheckInService/WakeStateService use.
		logger: app.log as unknown as import('pino').Logger,
	});
	app.decorate('wakeStateService', wakeStateService);

	app.register(healthRoutes);
	app.register(wakeRoutes); // Phase 9 CHAN-02

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

		// Flush any pending message cleanups from previous run
		const botInstance = (app as unknown as { bot?: Bot<StitchContext> }).bot;
		if (botInstance) {
			try {
				const flushed = await flushPendingCleanups(db, botInstance.api);
				if (flushed > 0) {
					app.log.info(`Flushed ${flushed} pending message cleanup(s) from previous run`);
				}
			} catch (err) {
				app.log.warn({ err }, 'Failed to flush pending cleanups on startup');
			}
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

		// Phase 9 (PLAN-05/06): start the CheckInService ticker.
		// start() is async and AWAITS the D-21 restart safety check-in internally
		// (see check-in-service.ts Plan 03 Task 2). Do NOT add a separate restart
		// safety block here -- it would double-fire.
		try {
			await checkInService.start();
			app.log.info(
				`CheckInService started (tick interval: ${config.NUDGE_TICK_INTERVAL_MS}ms)`,
			);
		} catch (err) {
			app.log.warn({ err }, 'CheckInService start failed');
		}
	});

	// Stop scheduler on app close
	app.addHook('onClose', async () => {
		scheduler.stop();
		// Phase 9: stop the CheckInService ticker
		try {
			await checkInService.stop();
		} catch (err) {
			app.log.warn({ err }, 'CheckInService stop failed');
		}
	});

	return app;
}

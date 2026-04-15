import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import type { Bot } from 'grammy';
import { flushPendingCleanups } from './channels/telegram/cleanup.js';
import { setupTelegramBot } from './channels/telegram/index.js';
import type { StitchContext } from './channels/telegram/types.js';
import { type AppConfig, loadConfig } from './config.js';
import { CheckInService } from './core/check-in-service.js';
import { DailyPlanService } from './core/daily-plan-service.js';
import { DayTreeService } from './core/day-tree-service.js';
import { IntentClassifierService } from './core/intent-classifier.js';
import { createRootLogger, formatStamp, recoverOrphanedLog } from './core/logger.js';
import { PredictionService } from './core/prediction-service.js';
import { RecurrenceScheduler } from './core/recurrence-scheduler.js';
import { TaskService } from './core/task-service.js';
import { WakeStateService } from './core/wake-state.js';
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

	// D-01 + Pitfall 2: recoverOrphanedLog MUST run BEFORE createRootLogger
	// opens stitch.log for writing, or the orphan from the previous session
	// gets overwritten instead of rotated.
	const logDir = path.resolve(config.LOG_DIR);
	recoverOrphanedLog(logDir, 'stitch.log');

	// D-05 + D-09: create the single root pino instance. Fastify will adopt
	// it as its own `.log` so every request/response line flows through the
	// pino-pretty file transport.
	//
	// `rootTransport` is the ThreadStream worker stream. We hold on to it so
	// the onClose hook below can end it + wait for its 'close' event BEFORE
	// renaming stitch.log — otherwise `fs.renameSync` fails with EBUSY on
	// Windows because the worker still owns the file handle (D-01 UAT fix).
	// Silent-mode callers get `transport: null`.
	const { logger: rootLogger, transport: rootTransport } = createRootLogger({
		level: config.LOG_LEVEL,
		logDir,
		logName: 'stitch.log',
	});

	// Pitfall 1: Fastify 5 renamed `logger` to `loggerInstance` when passing a
	// pre-built pino instance. Using the old key silently disables the custom
	// transport and falls back to Fastify's default stdout logger.
	const app = Fastify({
		loggerInstance: rootLogger,
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
	// D-10: per-service child logger so every log line is pre-tagged with
	// `service=TaskService` without the service knowing its own name.
	// D-12: logger is a REQUIRED arg — no `logger?: Logger` fallback.
	const taskService = new TaskService(db, rootLogger.child({ service: 'TaskService' }));
	app.decorate('taskService', taskService);

	// Day tree service
	const dayTreeService = new DayTreeService(
		db,
		llmProvider,
		rootLogger.child({ service: 'DayTreeService' }),
	);
	app.decorate('dayTreeService', dayTreeService);

	// Phase 10 (D-01): PredictionService — the "predict" half of predict-then-plan.
	// Constructed BEFORE DailyPlanService because DailyPlanService depends on it.
	// NO dailyPlanService dependency in the other direction (Pitfall 5 cycle guard).
	// D-09: `rootLogger.child(...)` — no more FastifyBaseLogger cast, pino all
	// the way down.
	const predictionService = new PredictionService(
		db,
		taskService,
		dayTreeService,
		llmProvider,
		rootLogger.child({ service: 'PredictionService' }),
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
		rootLogger.child({ service: 'DailyPlanService' }),
	);
	app.decorate('dailyPlanService', dailyPlanService);

	// Intent classifier service (Phase 08.4)
	// D-12: logger is REQUIRED and reordered ahead of the optional
	// dailyPlanService so the contract is "logger-first, optional-last".
	const intentClassifierService = new IntentClassifierService(
		llmProvider,
		dayTreeService,
		taskService,
		rootLogger.child({ service: 'IntentClassifierService' }),
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
		// D-09/D-10: real pino child logger — no cast needed now that the
		// whole app is wired around `rootLogger`.
		logger: rootLogger.child({ service: 'CheckInService' }),
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
			// Phase 12 D-12/D-11: tagged child logger so every downstream child
			// carries `service=telegram` in addition to the per-interaction
			// req_id synthesized at text/voice/hub-button entries.
			logger: rootLogger.child({ service: 'telegram' }),
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
		// D-09/D-10: real pino child logger.
		logger: rootLogger.child({ service: 'WakeStateService' }),
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
				app.log.info(
					`Daily plan generated for today: ${dailyPlanService.getPlanWithChunks(plan.id).chunks.length} chunks`,
				);
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
			app.log.info(`CheckInService started (tick interval: ${config.NUDGE_TICK_INTERVAL_MS}ms)`);
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

		// D-01: rename the active stitch.log to stitch-{stamp}.log on clean
		// close.
		//
		// Windows transport race fix (2026-04-15 UAT): simply waiting 100ms
		// for the pino-pretty worker to flush is NOT enough. The worker runs
		// in a Node worker thread (pino.transport → thread-stream) and keeps
		// the file descriptor open until we explicitly `end()` it and the
		// worker exits. On Windows, `fs.renameSync` on an open file fails
		// with EBUSY/EPERM — so the rename was a silent no-op and the orphan
		// only got rotated on NEXT boot via recoverOrphanedLog.
		//
		// Fix: end the transport and await its 'close' event (the worker
		// thread exits, releasing the fd) BEFORE renaming. 2s safety timeout
		// keeps shutdown bounded if something goes wrong with the worker.
		//
		// Skip entirely in silent mode — createRootLogger returns
		// `transport: null` in that path so there's no worker to close and
		// no file to rename. Keeps route/integration tests fast.
		if (rootTransport) {
			await new Promise<void>((resolve) => {
				let settled = false;
				const done = () => {
					if (settled) return;
					settled = true;
					resolve();
				};
				rootTransport.once('close', done);
				// Safety timeout — don't block shutdown forever if the worker
				// misbehaves. 2s is generous; normal close is ~tens of ms.
				setTimeout(done, 2000);
				rootTransport.end();
			});
		}

		const orphanPath = path.join(logDir, 'stitch.log');
		if (fs.existsSync(orphanPath)) {
			const stamp = formatStamp(new Date());
			let target = path.join(logDir, `stitch-${stamp}.log`);
			// Pitfall 9: collision-safe `-N` suffix for the case where two
			// closes land within the same second (stamp has 1s resolution).
			let counter = 0;
			while (fs.existsSync(target)) {
				counter += 1;
				target = path.join(logDir, `stitch-${stamp}-${counter}.log`);
			}
			try {
				fs.renameSync(orphanPath, target);
			} catch (err) {
				// Best-effort — don't let rotation failure abort shutdown.
				process.stderr.write(
					`Failed to rotate ${orphanPath} → ${target}: ${(err as Error).message}\n`,
				);
			}
		}
	});

	// Cast to the default FastifyInstance shape. Fastify's generics narrow when
	// `loggerInstance` is a pino `Logger` (specific) vs the declared
	// `FastifyBaseLogger` (structural). The narrower type is a subtype of the
	// wider one, so the cast is safe — we just sidestep TS refusing to widen.
	return app as unknown as FastifyInstance;
}

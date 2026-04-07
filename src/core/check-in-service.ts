import { format } from 'date-fns';
import { desc, eq } from 'drizzle-orm';
import type { Api } from 'grammy';
import type { Logger } from 'pino';
import { schedulePerMessageCleanup } from '../channels/telegram/cleanup.js';
import type { HubManager } from '../channels/telegram/hub.js';
import type { StitchDb } from '../db/index.js';
import { checkIns } from '../db/schema.js';
import { CHECK_IN_SYSTEM_PROMPT, buildCheckInUserPrompt } from '../prompts/check-in.js';
import { withSoul } from '../prompts/soul.js';
import type { LlmProvider } from '../providers/llm.js';
import { CheckInResponseSchema } from '../schemas/check-in.js';
import type { CheckInRow, TriggerReason } from '../types/check-in.js';
import { getCurrentChunk } from './current-chunk.js';
import type { DailyPlanService } from './daily-plan-service.js';
import type { DayTreeService } from './day-tree-service.js';
import type { TaskService } from './task-service.js';

/**
 * CheckInServiceOptions — Pitfall 5 options-object constructor (Phase 08.4).
 */
export interface CheckInServiceOptions {
	llmProvider: LlmProvider;
	dayTreeService: DayTreeService;
	taskService: TaskService;
	dailyPlanService: DailyPlanService;
	db: StitchDb;
	bot?: { api: Api }; // optional — late-bound via setBot() after Telegram setup
	hubManager?: HubManager; // optional — late-bound via setHubManager() after Telegram setup
	userChatId?: number; // from config.TELEGRAM_ALLOWED_USER_ID
	logger?: Logger;
	tickIntervalMs?: number; // default 30_000
	cleanupTtlMs?: number; // default 900_000 (15 min)
	now?: () => Date; // injected for test determinism
}

/**
 * CheckInService — Phase 9.
 *
 * Two-layer model (D-01):
 * - Layer 1: deterministic 30s ticker (start/stop/tick).
 * - Layer 2: LLM oracle (runOracle), called when nextCheckInAt is due,
 *            forced by lifecycle events via forceCheckIn().
 *
 * Pitfall 4 split (canonical reference: src/core/daily-plan-service.ts:49-200):
 * runOracle is structured as PHASE 1 (sync read) -> PHASE 2 (async LLM,
 * OUTSIDE transaction) -> PHASE 3 (sync DB write). Zero await inside any
 * db.transaction() callback.
 */
export class CheckInService {
	private timer: NodeJS.Timeout | null = null;
	private nextCheckInAt: Date | null = null;
	private readonly tickIntervalMs: number;
	private readonly cleanupTtlMs: number;
	private readonly now: () => Date;

	private readonly llmProvider: LlmProvider;
	private readonly dayTreeService: DayTreeService;
	private readonly taskService: TaskService;
	private readonly dailyPlanService: DailyPlanService;
	private readonly db: StitchDb;
	// bot + hubManager are late-bindable via setters (constructor accepts as optional)
	private bot?: { api: Api };
	private hubManager?: HubManager;
	private readonly userChatId?: number;
	private readonly logger?: Logger;

	constructor(opts: CheckInServiceOptions) {
		this.llmProvider = opts.llmProvider;
		this.dayTreeService = opts.dayTreeService;
		this.taskService = opts.taskService;
		this.dailyPlanService = opts.dailyPlanService;
		this.db = opts.db;
		this.bot = opts.bot;
		this.hubManager = opts.hubManager;
		this.userChatId = opts.userChatId;
		this.logger = opts.logger;
		this.tickIntervalMs = opts.tickIntervalMs ?? 30_000;
		this.cleanupTtlMs = opts.cleanupTtlMs ?? 900_000;
		this.now = opts.now ?? (() => new Date());
	}

	// ==========================================================
	// Late-binding setters (called from app.ts after Telegram bot is constructed)
	// ==========================================================

	/**
	 * Late-bind the grammY bot. The CheckInService constructor runs BEFORE the
	 * Telegram bot is built in app.ts (because the bot needs hub which needs
	 * services that depend on checkInService for forced check-ins). The setter
	 * pattern lets app.ts wire the bot in once it exists.
	 */
	setBot(bot: { api: Api } | undefined): void {
		this.bot = bot;
	}

	/**
	 * Late-bind the HubManager (same rationale as setBot).
	 */
	setHubManager(hub: HubManager): void {
		this.hubManager = hub;
	}

	/**
	 * Returns the currently bound HubManager, if any. Plan 09-05 NudgeOrchestrator
	 * uses this to refresh the hub display after lifecycle events. Exposed as a
	 * getter so the field is observably "read" and the Plan 09-03 phase compiles
	 * cleanly under strict noUnusedLocals.
	 */
	getHubManager(): HubManager | undefined {
		return this.hubManager;
	}

	// ==========================================================
	// Lifecycle (D-01 layer 1, D-21 restart safety)
	// ==========================================================

	/**
	 * Start the ticker. ASYNC because D-21 restart safety needs to AWAIT
	 * the forced 'restart' check-in before returning, so callers (and tests)
	 * can rely on the side effect having settled when start() resolves.
	 *
	 * App.ts owns the EXACTLY-ONE restart guarantee: app.ts must call
	 * `await checkInService.start()` and MUST NOT also fire its own restart
	 * (the restart logic lives here, not duplicated in onReady).
	 */
	async start(): Promise<void> {
		if (this.timer) return; // idempotent
		this.recomputeFromLastCheckIn(); // D-21 restart safety (sync DB read)
		this.timer = setInterval(() => {
			// Production callers ignore the returned promise; tests await tick() directly.
			void this.tick().catch((err) => {
				this.logger?.warn({ err }, 'CheckInService.tick failed');
			});
		}, this.tickIntervalMs);

		// D-21: enqueue back-online check-in if there's an active day.
		// AWAITED (not fire-and-forget) so tests can rely on the row existing
		// when start() resolves. Errors are caught and logged but not re-thrown
		// (a bad restart check-in must not block the ticker from running).
		const todayPlan = this.dailyPlanService.getTodayPlan() as
			| { id: number; startedAt?: string | null }
			| undefined;
		if (todayPlan?.startedAt) {
			try {
				await this.forceCheckIn('restart');
			} catch (err) {
				this.logger?.warn({ err }, 'CheckInService restart back-online check-in failed');
			}
		}
	}

	/**
	 * Stop the ticker. ASYNC for symmetry with start() — currently does no
	 * async work, but the signature allows future extension (e.g., awaiting
	 * an in-flight tick to settle before close).
	 */
	async stop(): Promise<void> {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	// ==========================================================
	// Tick (D-01 layer 1)
	// ==========================================================

	/**
	 * tick() is PUBLIC async (not private) so tests can `await service.tick()`
	 * directly without setInterval / fake timer gymnastics. Production callers
	 * (the setInterval handler) ignore the returned promise.
	 *
	 * Step 1: deterministic chunk lifecycle (Task 3 wires `runBufferEndDisposition`
	 *         in here — see Task 3 for the buffer-end dispatch loop).
	 * Step 2: LLM check-in oracle if next-check timer is due.
	 */
	async tick(): Promise<void> {
		// Step 1: chunk lifecycle (deterministic) -- buffer-end transitions
		// Task 3 REPLACES this stub with the buffer-end dispatch loop. The
		// dispatch loop reads the active day's chunks and calls
		// runBufferEndDisposition for any chunk where now >= endTime + 50% buffer.
		// Step 2: check-in evaluation (LLM oracle if due)
		if (this.shouldRunOracle()) {
			await this.runOracle('scheduled');
		}
	}

	private shouldRunOracle(): boolean {
		if (!this.nextCheckInAt) return false; // not initialized
		return this.now().getTime() >= this.nextCheckInAt.getTime();
	}

	// ==========================================================
	// Forced check-in (D-05)
	// ==========================================================

	async forceCheckIn(reason: TriggerReason): Promise<void> {
		await this.runOracle(reason);
	}

	// ==========================================================
	// Oracle (D-15, Pitfall 4 sync/async split)
	// ==========================================================

	private async runOracle(reason: TriggerReason): Promise<void> {
		// ---------- PHASE 1: Read context (sync, OUTSIDE transaction) ----------
		const tree = this.dayTreeService.getTree();
		const allTasks = this.taskService.list();
		const pendingTasks = allTasks
			.filter((t) => t.status === 'pending' || t.status === 'active')
			.map((t) => ({
				id: t.id,
				name: t.name,
				postponeCount: t.postponeCount,
				isEssential: t.isEssential,
			}));

		const todayPlan = this.dailyPlanService.getTodayPlan() as { id: number } | undefined;
		const chunks = todayPlan
			? this.dailyPlanService.getPlanWithChunks(todayPlan.id).chunks
			: [];
		const currentChunk = getCurrentChunk(chunks, this.now());

		const todaysCheckIns = this.loadTodaysCheckIns();

		const userPrompt = buildCheckInUserPrompt({
			triggerReason: reason,
			now: this.now(),
			tree,
			pendingTasks,
			currentChunk,
			todaysCheckIns,
		});

		// ---------- PHASE 2: LLM call (async, OUTSIDE transaction — D-22 fail-quiet) ----------
		let result: { should_speak: boolean; message: string | null; next_check_minutes: number };
		try {
			result = await this.llmProvider.complete({
				messages: [
					{ role: 'system', content: withSoul(CHECK_IN_SYSTEM_PROMPT) },
					{ role: 'user', content: userPrompt },
				],
				schema: CheckInResponseSchema,
				schemaName: 'check_in',
				temperature: 0.5,
				thinking: false,
				maxTokens: 512,
			});
		} catch (err) {
			this.logger?.warn({ err, reason }, 'check-in LLM call failed -- skipping (D-22 fail-quiet)');
			return; // D-22: fail quiet, don't reset next-check timer
		}

		// ---------- PHASE 2.5: Send Telegram first (D-23 memory poisoning guard) ----------
		let messageId: number | undefined;
		if (result.should_speak && result.message && this.bot && this.userChatId !== undefined) {
			try {
				const sent = await this.bot.api.sendMessage(this.userChatId, result.message, {
					parse_mode: 'HTML',
				});
				messageId = sent.message_id;
				schedulePerMessageCleanup(
					this.bot.api,
					this.userChatId,
					messageId,
					this.db,
					this.cleanupTtlMs,
					this.logger,
				);
			} catch (err) {
				this.logger?.warn(
					{ err, reason },
					'check-in send failed -- discarding for memory (D-23 memory poisoning guard)',
				);
				return; // D-23: do not persist, do not update next-check
			}
		}

		// ---------- PHASE 3: Persist row + update next-check timer (sync DB write) ----------
		this.db
			.insert(checkIns)
			.values({
				triggerReason: reason,
				shouldSpeak: result.should_speak,
				messageText: result.should_speak ? result.message : null,
				nextCheckMinutes: result.next_check_minutes,
				dayAnchor: format(this.now(), 'yyyy-MM-dd'),
			})
			.run();

		this.nextCheckInAt = new Date(this.now().getTime() + result.next_check_minutes * 60_000);
	}

	// ==========================================================
	// Restart safety (D-21)
	// ==========================================================

	private recomputeFromLastCheckIn(): void {
		const last = this.db
			.select()
			.from(checkIns)
			.where(eq(checkIns.dayAnchor, format(this.now(), 'yyyy-MM-dd')))
			.orderBy(desc(checkIns.createdAt))
			.limit(1)
			.get() as CheckInRow | undefined;

		if (!last || !last.nextCheckMinutes) {
			this.nextCheckInAt = null;
			return;
		}

		// SQLite datetime('now') returns 'YYYY-MM-DD HH:MM:SS' (UTC). Append 'Z' to parse as UTC.
		const lastTime = new Date(`${last.createdAt}Z`).getTime();
		const nextTime = lastTime + last.nextCheckMinutes * 60_000;
		this.nextCheckInAt = new Date(nextTime);

		// If the next check is overdue (e.g., we restarted after a long downtime),
		// the next tick will fire immediately because shouldRunOracle() returns true.
	}

	// ==========================================================
	// Memory loading (D-10)
	// ==========================================================

	private loadTodaysCheckIns(): CheckInRow[] {
		const today = format(this.now(), 'yyyy-MM-dd');
		return this.db
			.select()
			.from(checkIns)
			.where(eq(checkIns.dayAnchor, today))
			.orderBy(checkIns.createdAt)
			.all() as CheckInRow[];
	}
}

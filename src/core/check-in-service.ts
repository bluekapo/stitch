import { format } from 'date-fns';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Api } from 'grammy';
import type { Logger } from 'pino';
import { schedulePerMessageCleanup } from '../channels/telegram/cleanup.js';
import type { HubManager } from '../channels/telegram/hub.js';
import type { StitchDb } from '../db/index.js';
import { checkIns, planChunks, tasks } from '../db/schema.js';
import {
	BUFFER_END_DISPOSITION_PROMPT,
	buildCheckInUserPrompt,
	CHECK_IN_SYSTEM_PROMPT,
} from '../prompts/check-in.js';
import { withSoul } from '../prompts/soul.js';
import type { LlmProvider } from '../providers/llm.js';
import { BufferEndDispositionSchema, CheckInResponseSchema } from '../schemas/check-in.js';
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
	 * Step 1: deterministic chunk lifecycle. Pulls active day's plan + its
	 *         pending/active chunks, and dispatches runBufferEndDisposition for
	 *         any chunk past endTime + 50% buffer (Warning 6 wiring guard).
	 * Step 2: LLM check-in oracle if next-check timer is due.
	 */
	async tick(): Promise<void> {
		// ---------- PHASE 1: chunk lifecycle (deterministic, OUTSIDE transaction) ----------
		// Pull active day's plan + its pending/active chunks. All sync reads.
		const todayPlan = this.dailyPlanService.getTodayPlan() as
			| { id: number; startedAt?: string | null }
			| undefined;

		if (todayPlan?.startedAt) {
			const activeChunks = this.db
				.select()
				.from(planChunks)
				.where(
					and(
						eq(planChunks.planId, todayPlan.id),
						inArray(planChunks.status, ['pending', 'active']),
					),
				)
				.all();

			const now = this.now();
			const dateStr = now.toISOString().slice(0, 10);

			for (const chunk of activeChunks) {
				// Compute buffer end: endTime + 50% of (endTime - startTime).
				// startTime/endTime are 'HH:MM' strings — combine with today's date for absolute Date.
				const startMs = new Date(`${dateStr}T${chunk.startTime}:00`).getTime();
				const endMs = new Date(`${dateStr}T${chunk.endTime}:00`).getTime();
				const bufferMs = (endMs - startMs) * 0.5;
				const bufferEndMs = endMs + bufferMs;

				if (now.getTime() >= bufferEndMs) {
					// Dispatch disposition. Each call internally follows Pitfall 4 split.
					// Errors are swallowed at the disposition level (LLM fail = retry next tick).
					try {
						await this.runBufferEndDisposition(chunk.id);
					} catch (err) {
						this.logger?.warn({ err, chunkId: chunk.id }, 'tick: runBufferEndDisposition failed');
					}
				}
			}
		}

		// ---------- PHASE 2: regular check-in evaluation ----------
		if (this.shouldRunOracle()) {
			try {
				await this.runOracle('scheduled');
			} catch (err) {
				this.logger?.warn({ err }, 'tick: runOracle failed');
			}
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
		const chunks = todayPlan ? this.dailyPlanService.getPlanWithChunks(todayPlan.id).chunks : [];
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

	// ==========================================================
	// Buffer-end disposition (D-08, Pitfall 4 sync/async split)
	// ==========================================================

	/**
	 * Run buffer-end disposition for a chunk (D-08).
	 *
	 * Called from tick() when a chunk's [startTime, endTime) + 50% buffer
	 * has expired AND the chunk is still status='pending' or status='active'.
	 *
	 * Pitfall 4: this method MUST follow the PHASE 1/2/3 split. The LLM call
	 * resolves BEFORE db.transaction() opens. Zero await inside the callback.
	 */
	async runBufferEndDisposition(chunkId: number): Promise<void> {
		// ---------- PHASE 1: Read context (sync, OUTSIDE transaction) ----------
		const chunkRow = this.db.select().from(planChunks).where(eq(planChunks.id, chunkId)).get();
		if (!chunkRow) return;

		// Pull tasks attached to this chunk via tasks.chunkId (Phase 08.3 source of truth)
		const chunkTaskRows = this.taskService.listForChunk(chunkId);

		if (chunkTaskRows.length === 0) {
			// No tasks to dispose — just transition status to 'completed'
			this.db
				.update(planChunks)
				.set({ status: 'completed' })
				.where(eq(planChunks.id, chunkId))
				.run();
			return;
		}

		const tree = this.dayTreeService.getTree();
		const userPrompt = this.buildBufferEndUserPrompt(
			chunkRow,
			chunkTaskRows.map((t) => ({
				id: t.id,
				name: t.name,
				status: t.status,
				isEssential: t.isEssential,
			})),
			tree,
		);

		// ---------- PHASE 2: LLM call (async, OUTSIDE transaction — Pitfall 4) ----------
		let result: {
			decisions: Array<{
				taskId: number;
				action: 'continue' | 'postpone' | 'skip' | 'move_to_next_chunk';
			}>;
		};
		try {
			result = await this.llmProvider.complete({
				messages: [
					{ role: 'system', content: withSoul(BUFFER_END_DISPOSITION_PROMPT) },
					{ role: 'user', content: userPrompt },
				],
				schema: BufferEndDispositionSchema,
				schemaName: 'buffer_end_disposition',
				temperature: 0.3,
				thinking: false,
				maxTokens: 1024,
			});
		} catch (err) {
			this.logger?.warn({ err, chunkId }, 'buffer-end disposition LLM call failed -- skipping');
			// Skip the disposition; the next tick will retry. The chunk stays pending.
			return;
		}

		// Hallucination defense: drop decisions for taskIds NOT in the chunk
		const validTaskIds = new Set(chunkTaskRows.map((t) => t.id));
		const validDecisions = result.decisions.filter((d) => validTaskIds.has(d.taskId));

		// ---------- PHASE 3: All DB writes (sync, INSIDE db.transaction) ----------
		// NOTE: NO await inside this callback. taskService.skip/postpone are sync.
		this.db.transaction(() => {
			for (const decision of validDecisions) {
				switch (decision.action) {
					case 'continue':
						// Leave attached as-is. No-op.
						break;
					case 'postpone':
						// Phase 10 (D-22): write task_durations row + increment postpone_count
						// via taskService.postpone (chronic-procrastination signal). The
						// chunkId/branchName nulling is preserved as a follow-up update so the
						// "fully unattached" buffer-end semantic (Pitfall 6) survives the refactor.
						//
						// taskService.postpone has an isEssential guard that THROWS — wrap in
						// try/catch and fall back to the legacy status-only update so an
						// LLM-decided essential postpone still completes (no row written in the
						// fallback path; that is acceptable because the legacy code wrote no row
						// either, so this is strictly additive behavior).
						try {
							this.taskService.postpone(decision.taskId);
						} catch (err) {
							this.logger?.warn(
								{ err, taskId: decision.taskId },
								'buffer-end postpone rejected (likely essential task); falling back to status-only update',
							);
							this.db
								.update(tasks)
								.set({
									postponeCount: sql`postpone_count + 1`,
									status: 'pending',
									updatedAt: sql`(datetime('now'))`,
								})
								.where(eq(tasks.id, decision.taskId))
								.run();
						}
						this.db
							.update(tasks)
							.set({
								chunkId: null,
								branchName: null,
								updatedAt: sql`(datetime('now'))`,
							})
							.where(eq(tasks.id, decision.taskId))
							.run();
						break;
					case 'skip':
						// Phase 10 (D-22): taskService.skip writes the task_durations row
						// (chronic-procrastination signal) and sets status='skipped'.
						this.taskService.skip(decision.taskId);
						break;
					case 'move_to_next_chunk': {
						// Find the next chunk by sortOrder + planId
						const nextChunk = this.db
							.select()
							.from(planChunks)
							.where(
								and(
									eq(planChunks.planId, chunkRow.planId),
									sql`${planChunks.sortOrder} > ${chunkRow.sortOrder}`,
								),
							)
							.orderBy(planChunks.sortOrder)
							.limit(1)
							.get();
						if (nextChunk) {
							this.db
								.update(tasks)
								.set({
									chunkId: nextChunk.id,
									branchName: nextChunk.branchName,
									updatedAt: sql`(datetime('now'))`,
								})
								.where(eq(tasks.id, decision.taskId))
								.run();
						} else {
							// No next chunk — fall through to postpone semantics
							this.db
								.update(tasks)
								.set({
									postponeCount: sql`postpone_count + 1`,
									status: 'pending',
									chunkId: null,
									branchName: null,
									updatedAt: sql`(datetime('now'))`,
								})
								.where(eq(tasks.id, decision.taskId))
								.run();
						}
						break;
					}
				}
			}

			// Transition chunk status: 'completed' only when EVERY remaining task on
			// the chunk is status='completed'. Anything else (pending, active, skipped,
			// or unattached via postpone) leaves the chunk as 'skipped'. The semantic
			// is "did the chunk fully execute" — postpone/skip both mean "no".
			const remaining = this.db
				.select({ status: tasks.status })
				.from(tasks)
				.where(eq(tasks.chunkId, chunkId))
				.all();
			const allCompleted = remaining.length > 0 && remaining.every((t) => t.status === 'completed');
			const newStatus = allCompleted ? 'completed' : 'skipped';
			this.db.update(planChunks).set({ status: newStatus }).where(eq(planChunks.id, chunkId)).run();
		});
	}

	private buildBufferEndUserPrompt(
		chunk: { id: number; label: string; startTime: string; endTime: string },
		chunkTasksList: Array<{ id: number; name: string; status: string; isEssential: boolean }>,
		tree: { branches: Array<{ name: string; startTime: string; endTime: string }> } | undefined,
	): string {
		const lines: string[] = [];
		lines.push(`Expiring chunk: ${chunk.label} (${chunk.startTime}-${chunk.endTime})`);
		lines.push('');
		lines.push('Tasks in chunk (with current statuses):');
		for (const t of chunkTasksList) {
			const flag = t.isEssential ? ' [ESSENTIAL]' : '';
			lines.push(`- ID:${t.id} "${t.name}" status=${t.status}${flag}`);
		}
		if (tree && tree.branches.length > 0) {
			lines.push('');
			lines.push('Day tree (for context — what comes after this chunk):');
			for (const b of tree.branches) {
				lines.push(`- ${b.name} (${b.startTime}-${b.endTime})`);
			}
		}
		return lines.join('\n');
	}
}

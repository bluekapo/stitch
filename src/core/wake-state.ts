import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { StitchDb } from '../db/index.js';
import { dailyPlans } from '../db/schema.js';
import type { TriggerReason } from '../types/check-in.js';
import type { DailyPlanService } from './daily-plan-service.js';
import { computeLatestEndTime } from './day-boundary.js';
import type { DayTreeService } from './day-tree-service.js';

/**
 * Result of a single wake call (POST /wake/:secret).
 *
 * - 'snoozed': call landed inside the debounce window. Did NOT fire day-start.
 *   The route returns 200 with {status, wait_secs} so the iOS Shortcut can log it.
 * - 'fired':   call cleared the debounce window. Day-start sequence ran.
 * - 'already_started': day-lock is engaged (day-start already fired today, day boundary not yet crossed).
 */
export type WakeCallResult =
	| { status: 'snoozed'; wait_secs: number; day_anchor: string }
	| { status: 'fired'; day_anchor: string }
	| { status: 'already_started'; day_anchor: string };

/**
 * Minimal contract for the CheckInService dependency.
 *
 * Phase 09 Wave 2 cross-plan concern: Plan 09-03 owns CheckInService and may
 * still be in flight when this file lands. Rather than importing the concrete
 * class, we declare the narrow interface this service actually consumes
 * (`forceCheckIn(reason)`) and inject it at construction time. Plan 09-05 wires
 * the real CheckInService into app.ts. For unit tests, mock this interface.
 */
export interface CheckInServiceLike {
	forceCheckIn(reason: TriggerReason): Promise<void>;
}

/**
 * Pitfall 5 — options-object constructor. Single object, named fields,
 * future-proof against positional drift bugs as the dependency surface grows.
 */
export interface WakeStateServiceOptions {
	db: StitchDb;
	dailyPlanService: DailyPlanService;
	dayTreeService: DayTreeService;
	checkInService: CheckInServiceLike;
	debounceMs: number; // from config.WAKE_DEBOUNCE_MS (default 300_000)
	logger?: Logger;
	now?: () => Date; // injectable for tests; defaults to () => new Date()
}

export class WakeStateService {
	private db: StitchDb;
	private dailyPlanService: DailyPlanService;
	private dayTreeService: DayTreeService;
	private checkInService: CheckInServiceLike;
	private debounceMs: number;
	private logger: Logger | undefined;
	private now: () => Date;

	constructor(options: WakeStateServiceOptions) {
		this.db = options.db;
		this.dailyPlanService = options.dailyPlanService;
		this.dayTreeService = options.dayTreeService;
		this.checkInService = options.checkInService;
		this.debounceMs = options.debounceMs;
		this.logger = options.logger;
		this.now = options.now ?? (() => new Date());
	}

	/**
	 * Handle a single wake call. Implements D-19 two-layer idempotency:
	 *   Layer 1: snooze debounce window (wait for the LAST call in a 5-min cluster)
	 *   Layer 2: day-lock (day-start fires once per day, releases at day boundary)
	 *
	 * Order of checks (CRITICAL — do not reorder):
	 *   1. Compute today's date (local TZ).
	 *   2. Read today's dailyPlans row (or create on the fly via dailyPlanService).
	 *   3. If wake_fired_at is set AND not yet past day boundary -> already_started.
	 *   4. If wake_fired_at is set AND past day boundary -> day-lock released, fall through to step 6 (treat as fresh wake).
	 *   5. If last_wake_call_at is recent (now - last < debounceMs) -> snoozed (update last_wake_call_at to now, return wait_secs).
	 *   6. Otherwise -> fire day-start sequence, persist wake_fired_at + last_wake_call_at, return fired.
	 */
	async handleWakeCall(): Promise<WakeCallResult> {
		const nowDate = this.now();
		const dayAnchor = this.formatLocalDate(nowDate);

		// Step 1+2: ensure a plan row exists for today (so we have somewhere to persist wake state)
		// ensureTodayPlan is idempotent — returns existing or creates fresh
		const plan = await this.dailyPlanService.ensureTodayPlan();
		if (!plan) {
			// No day tree configured — cannot start a day. Return snoozed-equivalent so iOS retries.
			this.logger?.warn?.(
				{ dayAnchor },
				'WakeStateService: ensureTodayPlan returned undefined (no day tree?)',
			);
			return {
				status: 'snoozed',
				wait_secs: Math.floor(this.debounceMs / 1000),
				day_anchor: dayAnchor,
			};
		}

		// Re-read the row directly (we need the wake columns which DailyPlan type may not expose yet)
		const rows = this.db.select().from(dailyPlans).where(eq(dailyPlans.date, dayAnchor)).all();
		const row = rows[0];
		if (!row) {
			// Defensive — ensureTodayPlan succeeded but row is missing? Persist a fresh row.
			this.logger?.warn?.(
				{ dayAnchor },
				'WakeStateService: dailyPlans row missing immediately after ensureTodayPlan',
			);
			return {
				status: 'snoozed',
				wait_secs: Math.floor(this.debounceMs / 1000),
				day_anchor: dayAnchor,
			};
		}

		// Step 3+4: day-lock check
		// `dayLockReleased` is true when we just observed a stale wake_fired_at and
		// reset the row. In that case the rest of this call should behave like the
		// "first wake call of the day" — seed the snooze cycle and return snoozed.
		// This is the spec from D-24: "after now passes day boundary, the day-lock
		// releases (calling handleWakeCall again returns snoozed for the next cycle)".
		let dayLockReleased = false;
		if (row.wakeFiredAt) {
			const tree = this.dayTreeService.getTree();
			if (!this.isDayBoundaryCrossed(nowDate, tree, row.wakeFiredAt)) {
				return { status: 'already_started', day_anchor: dayAnchor };
			}
			// Day boundary crossed — wake_fired_at is stale (from previous day cycle).
			// Clear it AND last_wake_call_at so the rest of the function re-enters the
			// "first call of the day" branch (seed snooze, return snoozed).
			// The next call clear-of-debounce-window will fire fresh per D-19 layer 1.
			this.logger?.info?.(
				{ dayAnchor, wakeFiredAt: row.wakeFiredAt },
				'WakeStateService: day boundary crossed since last fire; resetting snooze cycle',
			);
			this.db
				.update(dailyPlans)
				.set({ wakeFiredAt: null, lastWakeCallAt: null })
				.where(eq(dailyPlans.date, dayAnchor))
				.run();
			dayLockReleased = true;
		}

		// Step 5: snooze debounce window
		// After a day-lock release we treat last_wake_call_at as null regardless of
		// what was on the row, so the new day's first call seeds a fresh window.
		if (!dayLockReleased && row.lastWakeCallAt) {
			const lastCallMs = new Date(row.lastWakeCallAt).getTime();
			const elapsed = nowDate.getTime() - lastCallMs;
			if (elapsed < this.debounceMs) {
				// RESET the debounce window (not just extend) — this is the "5-min sliding window" semantic
				this.db
					.update(dailyPlans)
					.set({ lastWakeCallAt: nowDate.toISOString() })
					.where(eq(dailyPlans.date, dayAnchor))
					.run();
				const waitSecs = Math.ceil((this.debounceMs - elapsed) / 1000);
				return { status: 'snoozed', wait_secs: waitSecs, day_anchor: dayAnchor };
			}
		} else {
			// First wake call of the day — record last_wake_call_at, then check whether enough time has passed
			// (it hasn't — it's the FIRST call), so return snoozed. The user must wait debounceMs and call again.
			this.db
				.update(dailyPlans)
				.set({ lastWakeCallAt: nowDate.toISOString() })
				.where(eq(dailyPlans.date, dayAnchor))
				.run();
			return {
				status: 'snoozed',
				wait_secs: Math.floor(this.debounceMs / 1000),
				day_anchor: dayAnchor,
			};
		}

		// Step 6: fire the day-start sequence (only path that reaches this is "elapsed >= debounceMs")
		await this.runDayStartSequence(dayAnchor, nowDate);
		return { status: 'fired', day_anchor: dayAnchor };
	}

	/**
	 * D-20 day-start sequence. Runs ONCE per day (idempotency enforced by handleWakeCall).
	 *
	 * Order:
	 *   1. dailyPlanService.ensureTodayPlan() — already called in handleWakeCall, but call again here for clarity & safety
	 *   2. UPDATE dailyPlans SET started_at = now, wake_fired_at = now, last_wake_call_at = now
	 *   3. checkInService.forceCheckIn('wake') — fire the good-morning check-in (D-20.4)
	 *
	 * NOTE D-20.1 originally specified a hub refresh as step 1. That was removed
	 * after a UAT regression: HubManager.updateHub(text) without a menu argument
	 * forwards `reply_markup: undefined` to editMessageText, which strips the
	 * inline keyboard from the pinned hub. The check-in message ('Good morning,
	 * Sir...') already serves as the day-start notification; the hub refreshes
	 * organically on next user interaction.
	 *
	 * NOTE: This is `private` because the only legitimate caller is handleWakeCall.
	 *       Tests can still exercise it indirectly via handleWakeCall.
	 */
	private async runDayStartSequence(dayAnchor: string, nowDate: Date): Promise<void> {
		// Step 1: ensureTodayPlan again (cheap re-call; idempotent)
		await this.dailyPlanService.ensureTodayPlan();

		// Step 2: persist wake state (started_at + wake_fired_at + last_wake_call_at)
		const nowIso = nowDate.toISOString();
		this.db
			.update(dailyPlans)
			.set({
				startedAt: nowIso,
				wakeFiredAt: nowIso,
				lastWakeCallAt: nowIso,
			})
			.where(eq(dailyPlans.date, dayAnchor))
			.run();

		// Step 3: fire the good-morning check-in (D-20.4)
		await this.checkInService.forceCheckIn('wake');
	}

	/**
	 * D-24 day boundary check. Returns true when the local wall-clock has crossed
	 * the latest endTime in the active day tree, OR (Pitfall 7 fallback) when
	 * computeLatestEndTime returns null AND the calendar date has changed since
	 * the last wake fire.
	 *
	 * @param now           Current Date (local TZ assumed)
	 * @param tree          Active day tree (or undefined)
	 * @param wakeFiredAt   ISO datetime string from dailyPlans.wake_fired_at
	 */
	isDayBoundaryCrossed(
		now: Date,
		tree: ReturnType<DayTreeService['getTree']>,
		wakeFiredAt: string,
	): boolean {
		const latest = computeLatestEndTime(tree);
		if (latest !== null) {
			// Compare current local time HH:MM against latest endTime HH:MM (string compare works because zero-padded)
			const hh = String(now.getHours()).padStart(2, '0');
			const mm = String(now.getMinutes()).padStart(2, '0');
			const nowHHMM = `${hh}:${mm}`;
			// Day boundary is crossed when the calendar date has rolled over
			// (covers wake call at 00:30 on a new day after a 23:00 endTime)
			// OR when now >= latest endTime on the same calendar date.
			if (this.formatLocalDate(now) !== this.formatLocalDate(new Date(wakeFiredAt))) {
				return true;
			}
			return nowHHMM >= latest;
		}
		// Fallback (Pitfall 7): empty/undefined tree — use calendar date change as the boundary
		return this.formatLocalDate(now) !== this.formatLocalDate(new Date(wakeFiredAt));
	}

	/**
	 * Format a Date as YYYY-MM-DD in local timezone.
	 * Centralized so tests can stub `now` and get consistent dayAnchor.
	 */
	private formatLocalDate(d: Date): string {
		const yyyy = d.getFullYear();
		const mm = String(d.getMonth() + 1).padStart(2, '0');
		const dd = String(d.getDate()).padStart(2, '0');
		return `${yyyy}-${mm}-${dd}`;
	}
}

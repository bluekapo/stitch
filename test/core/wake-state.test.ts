import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DailyPlanService } from '../../src/core/daily-plan-service.js';
import type { DayTreeService } from '../../src/core/day-tree-service.js';
import type { CheckInServiceLike } from '../../src/core/wake-state.js';
import { WakeStateService } from '../../src/core/wake-state.js';
import type { StitchDb } from '../../src/db/index.js';
import { dailyPlans } from '../../src/db/schema.js';
import type { DayTree } from '../../src/types/day-tree.js';
import { createTestDb } from '../helpers/db.js';
import { createTestLogger } from '../helpers/logger.js';

/**
 * WakeStateService unit tests.
 * Strategy: in-memory DB (createTestDb), mocked collaborator services
 * (DailyPlanService, DayTreeService, CheckInService), injectable
 * `now` for deterministic time advancement.
 */

const DEBOUNCE_MS = 300_000; // 5 min
const DAY_ANCHOR = '2026-04-07';

/** Build a basic 3-branch day tree. Latest endTime = 23:00. */
function buildTree(): DayTree {
	return {
		branches: [
			{ name: 'Wake', startTime: '07:00', endTime: '08:00', isTaskSlot: false, items: [] },
			{ name: 'Day', startTime: '08:00', endTime: '21:00', isTaskSlot: true, items: [] },
			{ name: 'Sleep', startTime: '22:30', endTime: '23:00', isTaskSlot: false, items: [] },
		],
	};
}

/** Seed an in-memory DB with a daily_plans row for the test date. */
function seedTodayPlan(db: StitchDb, date: string = DAY_ANCHOR): void {
	db.insert(dailyPlans)
		.values({
			date,
			status: 'active',
		})
		.run();
}

/** Build a service under test with explicit `now` injection. */
function buildSut(opts: { db: StitchDb; now: () => Date; tree?: DayTree }): {
	service: WakeStateService;
	mocks: {
		ensureTodayPlan: ReturnType<typeof vi.fn>;
		forceCheckIn: ReturnType<typeof vi.fn>;
		getTree: ReturnType<typeof vi.fn>;
	};
} {
	const ensureTodayPlan = vi.fn().mockResolvedValue({ id: 1, date: DAY_ANCHOR, status: 'active' });
	const forceCheckIn = vi.fn().mockResolvedValue(undefined);
	const getTree = vi.fn().mockReturnValue(opts.tree);

	// NOTE (Warning 7 — backward-compat policy): When this test mocks DailyPlanService it
	// sidesteps the constructor entirely. In production, DailyPlanService is constructed
	// POSITIONALLY (db, dayTreeService, taskService, llmProvider) — see src/core/daily-plan-service.ts
	// lines 14-20. Phase 09 deliberately does NOT migrate DailyPlanService to the options-object
	// pattern. Only NEW services in this phase (CheckInService, WakeStateService, IntentClassifierService)
	// follow Pitfall 5. The mixed style is intentional.
	const dailyPlanService = { ensureTodayPlan } as unknown as DailyPlanService;
	const dayTreeService = { getTree } as unknown as DayTreeService;
	const checkInService = { forceCheckIn } as unknown as CheckInServiceLike;

	const service = new WakeStateService({
		db: opts.db,
		dailyPlanService,
		dayTreeService,
		checkInService,
		debounceMs: DEBOUNCE_MS,
		now: opts.now,
		logger: createTestLogger(),
	});

	return { service, mocks: { ensureTodayPlan, forceCheckIn, getTree } };
}

describe('WakeStateService — D-19 two-layer idempotency', () => {
	let db: StitchDb;
	beforeEach(() => {
		db = createTestDb();
		seedTodayPlan(db);
	});

	describe('debounce window (Layer 1)', () => {
		it('first wake call returns snoozed and seeds last_wake_call_at (debounce seed)', async () => {
			const t0 = new Date(`${DAY_ANCHOR}T07:00:00.000`);
			const { service, mocks } = buildSut({ db, now: () => t0, tree: buildTree() });

			const result = await service.handleWakeCall();

			expect(result.status).toBe('snoozed');
			expect(mocks.forceCheckIn).not.toHaveBeenCalled();

			const row = db.select().from(dailyPlans).where(eq(dailyPlans.date, DAY_ANCHOR)).all()[0];
			expect(row.lastWakeCallAt).not.toBeNull();
			expect(row.wakeFiredAt).toBeNull();
			expect(row.startedAt).toBeNull();
		});

		it('second wake call within debounce window returns snoozed and resets the timer (debounce reset)', async () => {
			const t0 = new Date(`${DAY_ANCHOR}T07:00:00.000`);
			const t1 = new Date(`${DAY_ANCHOR}T07:02:00.000`); // +2 min, well inside 5 min window
			let now = t0;
			const { service, mocks } = buildSut({ db, now: () => now, tree: buildTree() });

			await service.handleWakeCall();
			now = t1;
			const result = await service.handleWakeCall();

			expect(result.status).toBe('snoozed');
			expect(mocks.forceCheckIn).not.toHaveBeenCalled();

			const row = db.select().from(dailyPlans).where(eq(dailyPlans.date, DAY_ANCHOR)).all()[0];
			// last_wake_call_at should be updated to t1
			expect(new Date(row.lastWakeCallAt!).getTime()).toBe(t1.getTime());
			expect(row.wakeFiredAt).toBeNull();
		});

		it('third wake call after debounce window expires fires the day-start sequence (debounce expires)', async () => {
			const t0 = new Date(`${DAY_ANCHOR}T07:00:00.000`);
			const t1 = new Date(`${DAY_ANCHOR}T07:02:00.000`); // +2 min, snooze
			const t2 = new Date(`${DAY_ANCHOR}T07:07:00.001`); // +5min1ms past t1, fires
			let now = t0;
			const { service, mocks } = buildSut({ db, now: () => now, tree: buildTree() });

			await service.handleWakeCall(); // seed
			now = t1;
			await service.handleWakeCall(); // snooze reset
			now = t2;
			const result = await service.handleWakeCall();

			expect(result.status).toBe('fired');
			expect(mocks.forceCheckIn).toHaveBeenCalledTimes(1);
			expect(mocks.forceCheckIn).toHaveBeenCalledWith('wake');

			const row = db.select().from(dailyPlans).where(eq(dailyPlans.date, DAY_ANCHOR)).all()[0];
			expect(row.wakeFiredAt).not.toBeNull();
			expect(row.startedAt).not.toBeNull();
			expect(row.lastWakeCallAt).not.toBeNull();
		});
	});

	describe('day-lock (Layer 2)', () => {
		it('day-lock — second wake call after fired returns already_started and does NOT re-fire', async () => {
			const t0 = new Date(`${DAY_ANCHOR}T07:00:00.000`);
			const tFire = new Date(`${DAY_ANCHOR}T07:06:00.000`); // past 5-min debounce
			const tLater = new Date(`${DAY_ANCHOR}T09:30:00.000`); // hours later, mid-day
			let now = t0;
			const { service, mocks } = buildSut({ db, now: () => now, tree: buildTree() });

			await service.handleWakeCall(); // seed
			now = tFire;
			await service.handleWakeCall(); // fires
			expect(mocks.forceCheckIn).toHaveBeenCalledTimes(1);

			now = tLater;
			const result = await service.handleWakeCall();

			expect(result.status).toBe('already_started');
			if (result.status === 'already_started') {
				expect(result.day_anchor).toBe(DAY_ANCHOR);
			}
			// Critically: forceCheckIn was NOT called a second time
			expect(mocks.forceCheckIn).toHaveBeenCalledTimes(1);
		});

		it('day-lock holds across many calls within the day boundary', async () => {
			const t0 = new Date(`${DAY_ANCHOR}T07:00:00.000`);
			const tFire = new Date(`${DAY_ANCHOR}T07:06:00.000`);
			let now = t0;
			const { service, mocks } = buildSut({ db, now: () => now, tree: buildTree() });

			await service.handleWakeCall();
			now = tFire;
			await service.handleWakeCall();

			// Spam 5 calls throughout the day — all return already_started
			for (const hour of [10, 13, 16, 19, 22]) {
				now = new Date(`${DAY_ANCHOR}T${String(hour).padStart(2, '0')}:00:00.000`);
				const result = await service.handleWakeCall();
				expect(result.status).toBe('already_started');
			}

			// Only 1 day-start fire across all those calls
			expect(mocks.forceCheckIn).toHaveBeenCalledTimes(1);
		});
	});

	describe('day boundary release (D-24)', () => {
		it('day boundary — after now >= max(branch.endTime), day-lock releases', async () => {
			const t0 = new Date(`${DAY_ANCHOR}T07:00:00.000`);
			const tFire = new Date(`${DAY_ANCHOR}T07:06:00.000`);
			// Latest endTime in buildTree() is 23:00. now = 23:30 same calendar date should release.
			const tAfterBoundary = new Date(`${DAY_ANCHOR}T23:30:00.000`);
			let now = t0;
			const { service, mocks } = buildSut({ db, now: () => now, tree: buildTree() });

			await service.handleWakeCall();
			now = tFire;
			await service.handleWakeCall();
			expect(mocks.forceCheckIn).toHaveBeenCalledTimes(1);

			now = tAfterBoundary;
			// Day boundary released — wake call enters the snooze cycle for the NEW day
			// (the row still has yesterday's wake_fired_at; the boundary check sees now > 23:00 same date and releases)
			const result = await service.handleWakeCall();
			expect(result.status).toBe('snoozed');
			// Side effect: now we're seeding the next day's snooze cycle, so forceCheckIn still 1
			expect(mocks.forceCheckIn).toHaveBeenCalledTimes(1);
		});
	});

	describe('empty tree midnight fallback (Pitfall 7)', () => {
		it('empty tree — day boundary released only when calendar date changes', async () => {
			const t0 = new Date(`${DAY_ANCHOR}T07:00:00.000`);
			const tFire = new Date(`${DAY_ANCHOR}T07:06:00.000`);
			const tSameDayLate = new Date(`${DAY_ANCHOR}T23:30:00.000`); // same calendar day, late
			const tNextDay = new Date('2026-04-08T07:00:00.000'); // next calendar day
			let now = t0;
			const { service, mocks } = buildSut({ db, now: () => now, tree: undefined }); // no tree

			await service.handleWakeCall();
			now = tFire;
			await service.handleWakeCall();
			expect(mocks.forceCheckIn).toHaveBeenCalledTimes(1);

			now = tSameDayLate;
			const sameDayResult = await service.handleWakeCall();
			// Empty tree + same calendar date -> day-lock holds
			expect(sameDayResult.status).toBe('already_started');

			now = tNextDay;
			// Need to seed the next day's plan row before the service tries to update it
			seedTodayPlan(db, '2026-04-08');
			const nextDayResult = await service.handleWakeCall();
			// Calendar date has changed -> midnight fallback releases the lock
			expect(nextDayResult.status).toBe('snoozed');
		});
	});
});

describe('WakeStateService — D-20 day-start sequence side effects', () => {
	let db: StitchDb;
	beforeEach(() => {
		db = createTestDb();
		seedTodayPlan(db);
	});

	it('day-start ensure plan — calls dailyPlanService.ensureTodayPlan at least once', async () => {
		const t0 = new Date(`${DAY_ANCHOR}T07:00:00.000`);
		const tFire = new Date(`${DAY_ANCHOR}T07:06:00.000`);
		let now = t0;
		const { service, mocks } = buildSut({ db, now: () => now, tree: buildTree() });

		await service.handleWakeCall();
		now = tFire;
		await service.handleWakeCall();

		// ensureTodayPlan is called per handleWakeCall (Step 1+2) AND inside runDayStartSequence (Step 1)
		// So total calls across the 2 handleWakeCall invocations:
		//   call 1: 1 (Step 1+2 only)
		//   call 2: 2 (Step 1+2 + Step 1 of runDayStartSequence)
		// Total: 3
		expect(mocks.ensureTodayPlan.mock.calls.length).toBeGreaterThanOrEqual(3);
	});

	it('day-start mark started — sets dailyPlans.started_at to current timestamp', async () => {
		const t0 = new Date(`${DAY_ANCHOR}T07:00:00.000`);
		const tFire = new Date(`${DAY_ANCHOR}T07:06:00.000`);
		let now = t0;
		const { service } = buildSut({ db, now: () => now, tree: buildTree() });

		await service.handleWakeCall();
		now = tFire;
		await service.handleWakeCall();

		const row = db.select().from(dailyPlans).where(eq(dailyPlans.date, DAY_ANCHOR)).all()[0];
		expect(row.startedAt).not.toBeNull();
		expect(new Date(row.startedAt!).getTime()).toBe(tFire.getTime());
	});

	it('day-start force check-in — calls checkInService.forceCheckIn with reason wake exactly once', async () => {
		const t0 = new Date(`${DAY_ANCHOR}T07:00:00.000`);
		const tFire = new Date(`${DAY_ANCHOR}T07:06:00.000`);
		let now = t0;
		const { service, mocks } = buildSut({ db, now: () => now, tree: buildTree() });

		await service.handleWakeCall();
		now = tFire;
		await service.handleWakeCall();

		expect(mocks.forceCheckIn).toHaveBeenCalledTimes(1);
		expect(mocks.forceCheckIn).toHaveBeenCalledWith('wake');
	});
});

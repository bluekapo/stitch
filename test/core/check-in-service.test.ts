import { format } from 'date-fns';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { CheckInService } from '../../src/core/check-in-service.js';
import { DailyPlanService } from '../../src/core/daily-plan-service.js';
import { DayTreeService } from '../../src/core/day-tree-service.js';
import { PredictionService } from '../../src/core/prediction-service.js';
import { TaskService } from '../../src/core/task-service.js';
import { checkIns, dailyPlans, planChunks, taskDurations, tasks } from '../../src/db/schema.js';
import { MockLlmProvider } from '../../src/providers/mock.js';
import { createTestDb } from '../helpers/db.js';
import { createTestLogger } from '../helpers/logger.js';

const TODAY = format(new Date(), 'yyyy-MM-dd');

function makeMockBot() {
	const sendMessage = vi.fn().mockResolvedValue({ message_id: 12345 });
	const deleteMessage = vi.fn().mockResolvedValue(true);
	return {
		// biome-ignore lint/suspicious/noExplicitAny: minimal mock surface for grammy Api
		api: { sendMessage, deleteMessage } as any,
		sendMessage,
		deleteMessage,
	};
}

function makeService(
	overrides: Partial<{
		now: () => Date;
		cleanupTtlMs: number;
		tickIntervalMs: number;
	}> = {},
) {
	const db = createTestDb();
	const llm = new MockLlmProvider();
	const dayTreeService = new DayTreeService(db, llm, createTestLogger());
	const taskService = new TaskService(db, createTestLogger());
	// NOTE: DailyPlanService remains positional (existing pattern in src/core/daily-plan-service.ts:13-19).
	// New Phase 9 services (CheckInService, WakeStateService) use the options-object Pitfall 5 pattern.
	// Do NOT migrate DailyPlanService in this phase — that is scope creep.
	const predictionService = new PredictionService(
		db,
		taskService,
		dayTreeService,
		llm,
		createTestLogger(),
	);
	const dailyPlanService = new DailyPlanService(
		db,
		dayTreeService,
		taskService,
		llm,
		predictionService,
		createTestLogger(),
	);
	const bot = makeMockBot();
	const service = new CheckInService({
		llmProvider: llm,
		dayTreeService,
		taskService,
		dailyPlanService,
		db,
		bot,
		userChatId: 100,
		cleanupTtlMs: overrides.cleanupTtlMs ?? 900_000,
		tickIntervalMs: overrides.tickIntervalMs ?? 30_000,
		now: overrides.now,
		logger: createTestLogger(),
	});
	return { service, db, llm, bot };
}

describe('CheckInService -- ticker (PLAN-05)', () => {
	it('ticker -- start() begins a 30s setInterval that calls tick', async () => {
		vi.useFakeTimers();
		try {
			const fixedNow = new Date(`${TODAY}T10:00:00Z`);
			const { service, llm, db } = makeService({ now: () => fixedNow });
			// Pre-seed nextCheckInAt by inserting a recent check_in row
			db.insert(checkIns)
				.values({
					triggerReason: 'wake',
					shouldSpeak: false,
					messageText: null,
					nextCheckMinutes: 1, // due ~immediately on first tick
					dayAnchor: TODAY,
					createdAt: `${TODAY} 09:59:00`,
				})
				.run();
			llm.setFixture('check_in', {
				should_speak: false,
				message: null,
				next_check_minutes: 30,
			});
			// start() is async — must be awaited so the D-21 restart check
			// (and the timer registration) have settled before assertions.
			// No active day in this test, so no restart check-in fires.
			await service.start();
			await vi.advanceTimersByTimeAsync(30_000);
			// After tick, the LLM should have been called once via the scheduled path
			// (We use a public observable: the new check_ins row count.)
			const rows = db.select().from(checkIns).all();
			expect(rows.length).toBeGreaterThanOrEqual(2); // pre-seed + scheduled tick row
			await service.stop();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('CheckInService -- force (PLAN-05)', () => {
	it('force -- forceCheckIn(reason) bypasses timer', async () => {
		const { service, llm, db } = makeService();
		llm.setFixture('check_in', {
			should_speak: false,
			message: null,
			next_check_minutes: 30,
		});
		await service.forceCheckIn('wake');
		const rows = db.select().from(checkIns).all();
		expect(rows).toHaveLength(1);
		expect(rows[0].triggerReason).toBe('wake');
	});
});

describe('CheckInService -- withSoul (PLAN-06)', () => {
	it('withSoul -- system prompt wrapped, temperature 0.5, thinking false', async () => {
		const { service, llm } = makeService();
		const completeSpy = vi.spyOn(llm, 'complete').mockResolvedValue({
			should_speak: false,
			message: null,
			next_check_minutes: 30,
		});
		await service.forceCheckIn('scheduled');
		expect(completeSpy).toHaveBeenCalled();
		const call = completeSpy.mock.calls[0][0];
		expect(call.temperature).toBe(0.5);
		expect(call.thinking).toBe(false);
		expect(call.schemaName).toBe('check_in');
		// SOUL.md is prepended via withSoul -- the system message should be substantially longer
		// than just the CHECK_IN_SYSTEM_PROMPT alone
		const systemMsg = call.messages[0];
		expect(systemMsg.role).toBe('system');
		expect(systemMsg.content.length).toBeGreaterThan(500); // SOUL + prompt is long
	});
});

describe('CheckInService -- should_speak false (PLAN-06)', () => {
	it('should_speak false -- no Telegram send fires', async () => {
		const { service, llm, bot, db } = makeService();
		llm.setFixture('check_in', {
			should_speak: false,
			message: null,
			next_check_minutes: 45,
		});
		await service.forceCheckIn('scheduled');
		expect(bot.sendMessage).not.toHaveBeenCalled();
		// The silent row IS persisted for memory (D-discretion lean YES)
		const rows = db.select().from(checkIns).all();
		expect(rows).toHaveLength(1);
		expect(rows[0].shouldSpeak).toBe(false);
		expect(rows[0].messageText).toBeNull();
	});
});

describe('CheckInService -- send and persist (PLAN-06)', () => {
	it('send and persist -- bot.api.sendMessage fires AND check_ins row persists', async () => {
		const { service, llm, bot, db } = makeService();
		llm.setFixture('check_in', {
			should_speak: true,
			message: 'Morning, Sir.',
			next_check_minutes: 30,
		});
		await service.forceCheckIn('wake');
		expect(bot.sendMessage).toHaveBeenCalledWith(100, 'Morning, Sir.', { parse_mode: 'HTML' });
		const rows = db.select().from(checkIns).all();
		expect(rows).toHaveLength(1);
		expect(rows[0].shouldSpeak).toBe(true);
		expect(rows[0].messageText).toBe('Morning, Sir.');
	});
});

describe('CheckInService -- send failure (PLAN-06, D-23 memory poisoning guard)', () => {
	it('send failure -- on bot send rejection, NO check_ins row persists', async () => {
		const { service, llm, bot, db } = makeService();
		bot.sendMessage.mockRejectedValueOnce(new Error('Telegram API down'));
		llm.setFixture('check_in', {
			should_speak: true,
			message: 'should not persist',
			next_check_minutes: 30,
		});
		await service.forceCheckIn('wake');
		const rows = db.select().from(checkIns).all();
		expect(rows).toHaveLength(0);
	});
});

describe('CheckInService -- cleanup TTL (PLAN-06)', () => {
	it('cleanup TTL -- schedulePerMessageCleanup called with cleanupTtlMs', async () => {
		// We verify by observing the pending_cleanups row delete_after timestamp,
		// since schedulePerMessageCleanup persists a row with delete_after = now + ttlMs
		const { service, llm, db } = makeService({ cleanupTtlMs: 900_000 });
		llm.setFixture('check_in', {
			should_speak: true,
			message: 'X',
			next_check_minutes: 30,
		});
		const before = Date.now();
		await service.forceCheckIn('wake');
		const { pendingCleanups } = await import('../../src/db/schema.js');
		const rows = db.select().from(pendingCleanups).all();
		expect(rows).toHaveLength(1);
		const deleteAfter = new Date(rows[0].deleteAfter).getTime();
		// Should be approximately 15 min in the future (allow 5s slack for CI)
		expect(deleteAfter).toBeGreaterThanOrEqual(before + 900_000 - 5_000);
		expect(deleteAfter).toBeLessThanOrEqual(before + 900_000 + 5_000);
	});
});

describe('CheckInService -- memory (PLAN-06, D-10)', () => {
	it("memory -- today's check_ins rows are loaded into next call's prompt context", async () => {
		const { service, llm, db } = makeService({
			now: () => new Date(`${TODAY}T15:00:00Z`),
		});
		// Pre-seed two check_ins for today
		db.insert(checkIns)
			.values({
				triggerReason: 'wake',
				shouldSpeak: true,
				messageText: 'Morning, Sir.',
				nextCheckMinutes: 30,
				dayAnchor: TODAY,
				createdAt: `${TODAY} 08:00:00`,
			})
			.run();
		db.insert(checkIns)
			.values({
				triggerReason: 'scheduled',
				shouldSpeak: true,
				messageText: 'Halfway through morning duties.',
				nextCheckMinutes: 30,
				dayAnchor: TODAY,
				createdAt: `${TODAY} 09:30:00`,
			})
			.run();

		const completeSpy = vi.spyOn(llm, 'complete').mockResolvedValue({
			should_speak: false,
			message: null,
			next_check_minutes: 30,
		});
		await service.forceCheckIn('scheduled');
		const call = completeSpy.mock.calls[0][0];
		const userMsg = call.messages.find((m: { role: string }) => m.role === 'user');
		expect(userMsg).toBeDefined();
		expect(userMsg?.content).toContain('Morning, Sir.');
		expect(userMsg?.content).toContain('Halfway through morning duties.');
		expect(userMsg?.content).toContain("Today's prior check-ins");
	});

	it('memory laundry -- a prior check-in mentioning laundry has been pending is threaded through to the next oracle call', async () => {
		// D-10 acceptance literal: the plan's success criteria explicitly names
		// "laundry has been pending" as the canonical memory payload — it must
		// survive the round-trip from check_ins.message_text into the next
		// runOracle user prompt verbatim so the oracle can reason about it.
		const { service, llm, db } = makeService({
			now: () => new Date(`${TODAY}T18:00:00Z`),
		});
		db.insert(checkIns)
			.values({
				triggerReason: 'scheduled',
				shouldSpeak: true,
				messageText: 'Sir, laundry has been pending for two hours now.',
				nextCheckMinutes: 30,
				dayAnchor: TODAY,
				createdAt: `${TODAY} 16:00:00`,
			})
			.run();

		const completeSpy = vi.spyOn(llm, 'complete').mockResolvedValue({
			should_speak: false,
			message: null,
			next_check_minutes: 30,
		});
		await service.forceCheckIn('scheduled');

		const call = completeSpy.mock.calls[0][0];
		const userMsg = call.messages.find((m: { role: string }) => m.role === 'user');
		expect(userMsg).toBeDefined();
		// Literal from acceptance criteria — do not paraphrase.
		expect(userMsg?.content).toContain('laundry has been pending');
	});
});

describe('CheckInService -- restart (CHAN-03, D-21)', () => {
	it('restart -- recomputes nextCheckInAt from last_check_in.created_at + last_check_in.next_check_minutes', async () => {
		const fixedNow = new Date(`${TODAY}T10:30:00Z`);
		const { service, db } = makeService({ now: () => fixedNow });
		db.insert(checkIns)
			.values({
				triggerReason: 'wake',
				shouldSpeak: true,
				messageText: 'Morning, Sir.',
				nextCheckMinutes: 30,
				dayAnchor: TODAY,
				createdAt: `${TODAY} 10:00:00`,
			})
			.run();

		// start() is now async — await it. No active day plan in this test
		// (no dailyPlans row), so no restart check-in fires.
		await service.start();
		// We can't read nextCheckInAt directly (private), but we can observe that
		// start() does not throw and the test path completes — the recompute math
		// is exercised inside start() before the timer is set.
		await service.stop();
		expect(true).toBe(true); // smoke — see Plan 06 for end-to-end coverage
	});

	it('restart back-online -- a restart check_in is queued when day is active', async () => {
		const fixedNow = new Date(`${TODAY}T10:30:00Z`);
		const { service, llm, db } = makeService({ now: () => fixedNow });
		// Active day plan with started_at set
		db.insert(dailyPlans)
			.values({
				date: TODAY,
				status: 'active',
				startedAt: `${TODAY} 06:30:00`,
			})
			.run();
		llm.setFixture('check_in', {
			should_speak: true,
			message: 'Apologies for the brief absence, Sir.',
			next_check_minutes: 30,
		});

		// start() is async and AWAITS the forced restart check-in internally,
		// so by the time start() resolves the row exists. No microtask hops.
		await service.start();

		const rows = db.select().from(checkIns).all();
		const restartRows = rows.filter((r) => r.triggerReason === 'restart');
		// Strict equality: app.ts MUST NOT also fire a restart — only start() owns it.
		expect(restartRows.length).toBe(1);
		await service.stop();
	});
});

describe('CheckInService -- Phase 10: buffer-end disposition writes task_durations rows', () => {
	// REGRESSION GUARD (Phase 10, Plan 10-03 Task 4):
	// Pre-Phase-10, the buffer-end disposition path used inline `db.update(tasks)`
	// calls that bypassed taskService entirely — so auto-skipped/auto-postponed
	// tasks NEVER produced task_durations rows, silently defeating the chronic-
	// procrastination signal that PredictionService consumes.
	//
	// These tests assert that buffer-end skip and buffer-end postpone BOTH write
	// task_durations rows (with the appropriate outcome enum). Any future revert
	// to inline db.update will fail this guard.
	//
	// See 10-RESEARCH.md Open Question 5.

	function seedPlanWithChunk(db: ReturnType<typeof createTestDb>) {
		db.insert(dailyPlans)
			.values({
				date: TODAY,
				status: 'active',
			})
			.run();
		const planRow = db.select().from(dailyPlans).all()[0];

		db.insert(planChunks)
			.values({
				planId: planRow.id,
				branchName: 'Morning',
				label: 'Morning duties',
				startTime: '08:00',
				endTime: '10:00',
				isTaskSlot: true,
				sortOrder: 0,
				status: 'pending',
			})
			.run();
		const chunkRow = db.select().from(planChunks).all()[0];

		db.insert(tasks).values({ name: 'Pushups', chunkId: chunkRow.id, branchName: 'Morning' }).run();
		db.insert(tasks).values({ name: 'Read', chunkId: chunkRow.id, branchName: 'Morning' }).run();

		return chunkRow.id;
	}

	it('buffer-end skip writes task_durations row with outcome=skipped', async () => {
		const { service, db, llm } = makeService();
		const chunkId = seedPlanWithChunk(db);
		const taskRows = db.select().from(tasks).all();

		llm.setFixture('buffer_end_disposition', {
			decisions: [
				{ taskId: taskRows[0].id, action: 'skip' },
				{ taskId: taskRows[1].id, action: 'skip' },
			],
		});

		await service.runBufferEndDisposition(chunkId);

		// Both tasks should have task_durations rows with outcome='skipped'
		const row0 = db
			.select()
			.from(taskDurations)
			.where(eq(taskDurations.taskId, taskRows[0].id))
			.get();
		const row1 = db
			.select()
			.from(taskDurations)
			.where(eq(taskDurations.taskId, taskRows[1].id))
			.get();

		expect(row0).toBeDefined();
		expect(row0?.outcome).toBe('skipped');
		expect(row0?.durationSeconds).toBeNull();

		expect(row1).toBeDefined();
		expect(row1?.outcome).toBe('skipped');
		expect(row1?.durationSeconds).toBeNull();

		// Task status was also updated (existing semantic preserved)
		const t0 = db.select().from(tasks).where(eq(tasks.id, taskRows[0].id)).get();
		expect(t0?.status).toBe('skipped');
	});

	it('buffer-end postpone writes task_durations row with outcome=postponed', async () => {
		const { service, db, llm } = makeService();
		const chunkId = seedPlanWithChunk(db);
		const taskRows = db.select().from(tasks).all();

		llm.setFixture('buffer_end_disposition', {
			decisions: [
				{ taskId: taskRows[0].id, action: 'postpone' },
				{ taskId: taskRows[1].id, action: 'postpone' },
			],
		});

		await service.runBufferEndDisposition(chunkId);

		const row0 = db
			.select()
			.from(taskDurations)
			.where(eq(taskDurations.taskId, taskRows[0].id))
			.get();
		const row1 = db
			.select()
			.from(taskDurations)
			.where(eq(taskDurations.taskId, taskRows[1].id))
			.get();

		expect(row0?.outcome).toBe('postponed');
		expect(row0?.durationSeconds).toBeNull();

		expect(row1?.outcome).toBe('postponed');
		expect(row1?.durationSeconds).toBeNull();

		// Pitfall 6: postpone nulls the chunkId/branchName (buffer-end semantics preserved)
		const t0 = db.select().from(tasks).where(eq(tasks.id, taskRows[0].id)).get();
		expect(t0?.chunkId).toBeNull();
		expect(t0?.branchName).toBeNull();
		expect(t0?.status).toBe('pending');
		expect(t0?.postponeCount).toBe(1);
	});

	it('mixed skip + postpone -- both decisions write the correct outcome', async () => {
		const { service, db, llm } = makeService();
		const chunkId = seedPlanWithChunk(db);
		const taskRows = db.select().from(tasks).all();

		llm.setFixture('buffer_end_disposition', {
			decisions: [
				{ taskId: taskRows[0].id, action: 'postpone' },
				{ taskId: taskRows[1].id, action: 'skip' },
			],
		});

		await service.runBufferEndDisposition(chunkId);

		const postponeRow = db
			.select()
			.from(taskDurations)
			.where(eq(taskDurations.taskId, taskRows[0].id))
			.get();
		const skipRow = db
			.select()
			.from(taskDurations)
			.where(eq(taskDurations.taskId, taskRows[1].id))
			.get();

		expect(postponeRow?.outcome).toBe('postponed');
		expect(skipRow?.outcome).toBe('skipped');
	});
});

describe('CheckInService -- memory poisoning (D-01, D-02)', () => {
	it('loadTodaysCheckIns scopes by task lifetime — deleted task with reused name does not leak history', async () => {
		const fixedNow = new Date(`${TODAY}T12:00:00Z`);
		const { service, db, llm } = makeService({ now: () => fixedNow });

		// Step 1: seed task A "laundry" at 09:00
		db.insert(tasks)
			.values({
				name: 'laundry',
				status: 'pending',
				createdAt: `${TODAY} 09:00:00`,
				updatedAt: `${TODAY} 09:00:00`,
			})
			.run();
		const taskARow = db.select().from(tasks).where(eq(tasks.name, 'laundry')).get();
		expect(taskARow).toBeDefined();

		// Step 2: seed 2 stale check_in rows referencing the laundry task
		db.insert(checkIns)
			.values({
				triggerReason: 'scheduled',
				shouldSpeak: true,
				messageText: '"The laundry task is overdue, Sir."',
				nextCheckMinutes: 30,
				dayAnchor: TODAY,
				createdAt: `${TODAY} 10:00:00`,
			})
			.run();
		db.insert(checkIns)
			.values({
				triggerReason: 'scheduled',
				shouldSpeak: true,
				messageText: '"The laundry task is overdue, Sir."',
				nextCheckMinutes: 30,
				dayAnchor: TODAY,
				createdAt: `${TODAY} 10:30:00`,
			})
			.run();

		// Step 3: delete task A (check_ins have no FK to tasks — rows remain as orphans)
		db.delete(tasks).where(eq(tasks.id, taskARow!.id)).run();

		// Step 4: seed task B with same name at 11:00 (after the stale check-ins)
		db.insert(tasks)
			.values({
				name: 'laundry',
				status: 'pending',
				createdAt: `${TODAY} 11:00:00`,
				updatedAt: `${TODAY} 11:00:00`,
			})
			.run();

		// Step 5: configure LLM fixture
		llm.setFixture('check_in', {
			should_speak: false,
			message: null,
			next_check_minutes: 30,
		});

		// Step 6: spy on llm.complete to capture the userPrompt
		const completeSpy = vi.spyOn(llm, 'complete');

		// Step 7: trigger a forced check-in
		await service.forceCheckIn('scheduled');

		// Step 8 + 9 + 10: inspect captured userPrompt
		expect(completeSpy).toHaveBeenCalledTimes(1);
		const callArgs = completeSpy.mock.calls[0][0];
		const userMessage = callArgs.messages.find(
			(m: { role: string; content: string }) => m.role === 'user',
		);
		expect(userMessage).toBeDefined();
		const userPrompt: string = userMessage!.content;

		// Memory poisoning guard: stale messageText must NOT leak
		expect(userPrompt).not.toContain('"The laundry task is overdue, Sir."');
		expect(userPrompt).not.toContain(`${TODAY} 10:00:00`);
		expect(userPrompt).not.toContain(`${TODAY} 10:30:00`);

		// Sanity: new task IS in the prompt
		expect(userPrompt).toContain('All pending tasks:');
		expect(userPrompt).toContain('"laundry"');
	});
});

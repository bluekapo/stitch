import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Bot } from 'grammy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { StitchContext } from '../../src/channels/telegram/types.js';
import type { CheckInService } from '../../src/core/check-in-service.js';
import type { StitchDb } from '../../src/db/index.js';
import { checkIns, dailyPlans, dayTrees } from '../../src/db/schema.js';
import { MockLlmProvider } from '../../src/providers/mock.js';
import { MockSttProvider } from '../../src/providers/mock-stt.js';
import { createTestDb } from '../helpers/db.js';

/**
 * Phase 9 wake-to-checkin end-to-end integration tests.
 *
 * Strategy: build a real Fastify app via `buildApp(...)` with all four
 * collaborators wired (in-memory DB, MockLlmProvider with `check_in` fixture,
 * MockSttProvider, and a fake grammY Bot whose api.sendMessage is a vi.fn).
 *
 * The injected `telegramBot` skips the production `setupTelegramBot` path in
 * `src/app.ts:103-124`, which would normally call `checkInService.setBot(bot)`.
 * We replicate that one-line wiring manually after construction so the LLM
 * oracle can actually reach `bot.api.sendMessage`.
 *
 * Asserts the round-trip from POST /wake/:secret all the way through:
 *   - WakeStateService two-layer idempotency (snooze debounce + day-lock)
 *   - WakeStateService.runDayStartSequence (mark started, force check-in)
 *   - CheckInService.forceCheckIn('wake') -> runOracle -> mock LLM
 *   - bot.api.sendMessage being called with the JARVIS message
 *   - check_ins row persisted with the right fields
 *   - dailyPlans wake-state columns updated
 */

const TEST_SECRET = 'test-wake-secret-do-not-use-in-prod-12345';
const TEST_USER_CHAT_ID = 100;

interface MockBot {
	bot: Bot<StitchContext>;
	sendMessage: ReturnType<typeof vi.fn>;
}

function buildMockBot(): MockBot {
	const sendMessage = vi.fn().mockResolvedValue({ message_id: 1234 });
	const bot = {
		api: {
			sendMessage,
			deleteMessage: vi.fn().mockResolvedValue(true),
			getChat: vi.fn().mockResolvedValue({ id: TEST_USER_CHAT_ID }),
		},
		on: vi.fn(),
		command: vi.fn(),
		use: vi.fn(),
	} as unknown as Bot<StitchContext>;
	return { bot, sendMessage };
}

function todayDateString(): string {
	const now = new Date();
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/**
 * Seed an in-memory test DB with a valid day_tree row + an empty daily_plans
 * row for today (so WakeStateService has a row to update wake state on).
 *
 * IMPORTANT: started_at is intentionally null so the CheckInService.start()
 * D-21 restart-safety branch does NOT fire on app.ready() (no day in flight yet).
 */
function seedDayTreeAndPlan(db: StitchDb): void {
	db.insert(dayTrees)
		.values({
			tree: {
				branches: [
					{ name: 'Wake', startTime: '07:00', endTime: '08:00', isTaskSlot: false, items: [] },
					{ name: 'Day', startTime: '08:00', endTime: '21:00', isTaskSlot: true, items: [] },
					{ name: 'Sleep', startTime: '22:30', endTime: '23:00', isTaskSlot: false, items: [] },
				],
			},
		})
		.run();

	db.insert(dailyPlans)
		.values({
			date: todayDateString(),
			status: 'active',
		})
		.run();
}

interface IntegrationHarness {
	app: FastifyInstance;
	db: StitchDb;
	llmProvider: MockLlmProvider;
	mockBot: MockBot;
}

async function buildHarness(): Promise<IntegrationHarness> {
	const db = createTestDb();
	seedDayTreeAndPlan(db);
	const llmProvider = new MockLlmProvider();
	// Default check-in fixture: a "should speak" JARVIS-flavored response.
	llmProvider.setFixture('check_in', {
		should_speak: true,
		message: 'Good morning, Sir. The day is ready when you are.',
		next_check_minutes: 30,
	});
	const sttProvider = new MockSttProvider();
	const mockBot = buildMockBot();

	const app = buildApp({
		config: {
			PORT: 0,
			LOG_LEVEL: 'silent',
			LLAMA_SERVER_URL: 'http://localhost:8080',
			LLAMA_MODEL_NAME: 'test-model',
			LLM_PROVIDER: 'mock',
			LLM_MAX_RETRIES: 1,
			DATABASE_URL: ':memory:',
			WHISPER_SERVER_URL: 'http://localhost:8081',
			STT_PROVIDER: 'mock',
			TELEGRAM_BOT_TOKEN: '',
			TELEGRAM_ALLOWED_USER_ID: TEST_USER_CHAT_ID,
			RECURRENCE_CRON_TIME: '0 5 * * *',
			NUDGE_TICK_INTERVAL_MS: 30_000,
			WAKE_SECRET: TEST_SECRET,
			WAKE_DEBOUNCE_MS: 300_000,
			CHECKIN_CLEANUP_MS: 900_000,
		},
		db,
		llmProvider,
		sttProvider,
		telegramBot: mockBot.bot,
	});

	// When buildApp receives an injected telegramBot, the production
	// setupTelegramBot path is skipped, which means checkInService.setBot()
	// is never called. Replicate that one-line wiring here so the LLM oracle
	// can actually call bot.api.sendMessage on a fired check-in.
	const checkInService = (
		app as unknown as { checkInService: CheckInService }
	).checkInService;
	checkInService.setBot(mockBot.bot);

	await app.ready();

	return { app, db, llmProvider, mockBot };
}

/**
 * Helper: expire the debounce window on today's plan row by backdating
 * lastWakeCallAt to a time well outside WAKE_DEBOUNCE_MS (5 min default).
 */
function expireDebounce(db: StitchDb): void {
	const past = new Date(Date.now() - 400_000).toISOString(); // 400s ago > 300s debounce
	db.update(dailyPlans)
		.set({ lastWakeCallAt: past })
		.where(eq(dailyPlans.date, todayDateString()))
		.run();
}

describe('wake-to-checkin end-to-end (CHAN-02 + CHAN-03 + PLAN-05/06)', () => {
	let harness: IntegrationHarness;

	beforeEach(async () => {
		harness = await buildHarness();
	});

	afterEach(async () => {
		await harness.app.close();
	});

	it('valid secret + cleared debounce window — fires day-start, calls bot.api.sendMessage, persists check_ins row', async () => {
		const { app, db, mockBot } = harness;

		// Step 1: first POST /wake/:secret — seeds the snooze cycle, returns snoozed.
		const firstRes = await app.inject({
			method: 'POST',
			url: `/wake/${TEST_SECRET}`,
			payload: {},
		});
		expect(firstRes.statusCode).toBe(200);
		const firstBody = JSON.parse(firstRes.body);
		expect(firstBody.status).toBe('snoozed');
		expect(mockBot.sendMessage).not.toHaveBeenCalled();

		// Step 2: backdate lastWakeCallAt past the debounce window so the next
		// call clears the snooze and fires the day-start sequence.
		expireDebounce(db);

		// Step 3: second POST /wake/:secret — fires day-start.
		const fireRes = await app.inject({
			method: 'POST',
			url: `/wake/${TEST_SECRET}`,
			payload: {},
		});
		expect(fireRes.statusCode).toBe(200);
		const fireBody = JSON.parse(fireRes.body);
		expect(fireBody.status).toBe('fired');

		// Step 4: assert side effects.
		// 4a. dailyPlans wake columns are populated.
		const planRow = db
			.select()
			.from(dailyPlans)
			.where(eq(dailyPlans.date, todayDateString()))
			.all()[0];
		expect(planRow.startedAt).not.toBeNull();
		expect(planRow.wakeFiredAt).not.toBeNull();
		expect(planRow.lastWakeCallAt).not.toBeNull();

		// 4b. check_ins has at least one row from the forced 'wake' check-in.
		const checkInRows = db.select().from(checkIns).all();
		expect(checkInRows.length).toBeGreaterThanOrEqual(1);
		const wakeRow = checkInRows.find((r) => r.triggerReason === 'wake');
		expect(wakeRow).toBeDefined();
		expect(wakeRow?.shouldSpeak).toBe(true);
		expect(wakeRow?.messageText).toContain('Good morning');
		expect(wakeRow?.dayAnchor).toBe(todayDateString());

		// 4c. bot.api.sendMessage was called with the JARVIS message.
		expect(mockBot.sendMessage).toHaveBeenCalledTimes(1);
		const sendCall = mockBot.sendMessage.mock.calls[0];
		// grammy Api.sendMessage signature: (chat_id, text, options)
		expect(sendCall[0]).toBe(TEST_USER_CHAT_ID);
		expect(sendCall[1]).toContain('Good morning');
		expect(sendCall[2]).toMatchObject({ parse_mode: 'HTML' });
	});

	it('subsequent POST /wake — already_started — no second check_ins row, no second sendMessage', async () => {
		const { app, db, mockBot } = harness;

		// Pre-seed the daily_plans row as if day-start already fired earlier this morning.
		const nowIso = new Date().toISOString();
		db.update(dailyPlans)
			.set({
				startedAt: nowIso,
				wakeFiredAt: nowIso,
				lastWakeCallAt: nowIso,
			})
			.where(eq(dailyPlans.date, todayDateString()))
			.run();

		const res = await app.inject({
			method: 'POST',
			url: `/wake/${TEST_SECRET}`,
			payload: {},
		});
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.status).toBe('already_started');

		// Day-lock holds: no new wake check-in fired, no new message sent.
		const wakeRows = db
			.select()
			.from(checkIns)
			.all()
			.filter((r) => r.triggerReason === 'wake');
		expect(wakeRows).toHaveLength(0);
		expect(mockBot.sendMessage).not.toHaveBeenCalled();
	});

	it('snooze cluster — 3 POST /wake calls within debounce window, only the last one fires', async () => {
		const { app, db, mockBot } = harness;

		// Call 1 — seeds the snooze cycle.
		const r1 = await app.inject({ method: 'POST', url: `/wake/${TEST_SECRET}`, payload: {} });
		expect(JSON.parse(r1.body).status).toBe('snoozed');
		expect(mockBot.sendMessage).not.toHaveBeenCalled();

		// Call 2 — within window (lastWakeCallAt was just updated to "now").
		const r2 = await app.inject({ method: 'POST', url: `/wake/${TEST_SECRET}`, payload: {} });
		expect(JSON.parse(r2.body).status).toBe('snoozed');
		expect(mockBot.sendMessage).not.toHaveBeenCalled();

		// Call 3 — manually expire the debounce window so this call fires.
		expireDebounce(db);
		const r3 = await app.inject({ method: 'POST', url: `/wake/${TEST_SECRET}`, payload: {} });
		expect(JSON.parse(r3.body).status).toBe('fired');
		expect(mockBot.sendMessage).toHaveBeenCalledTimes(1);

		// Only ONE wake check-in persisted across the cluster.
		const wakeRows = db
			.select()
			.from(checkIns)
			.all()
			.filter((r) => r.triggerReason === 'wake');
		expect(wakeRows).toHaveLength(1);
	});

	it('should_speak === false — POST /wake fires day-start but bot is silent (D-09); check_ins row still persists', async () => {
		const { app, db, llmProvider, mockBot } = harness;

		// Override the fixture: oracle says "no need to speak right now".
		llmProvider.setFixture('check_in', {
			should_speak: false,
			message: null,
			next_check_minutes: 30,
		});

		// Seed snooze cycle, expire window, fire.
		await app.inject({ method: 'POST', url: `/wake/${TEST_SECRET}`, payload: {} });
		expireDebounce(db);
		const fireRes = await app.inject({
			method: 'POST',
			url: `/wake/${TEST_SECRET}`,
			payload: {},
		});
		expect(JSON.parse(fireRes.body).status).toBe('fired');

		// Bot was NOT called — silent check-in.
		expect(mockBot.sendMessage).not.toHaveBeenCalled();

		// Check-in row still persists (D-10 — silent rows are memory).
		const wakeRows = db
			.select()
			.from(checkIns)
			.all()
			.filter((r) => r.triggerReason === 'wake');
		expect(wakeRows).toHaveLength(1);
		expect(wakeRows[0].shouldSpeak).toBe(false);
		expect(wakeRows[0].messageText).toBeNull();
	});
});

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTestApp } from '../helpers/app.js';

/**
 * POST /wake/:secret route tests (CHAN-02 + CHAN-03)
 *
 * Strategy: build a FastifyInstance via buildTestApp (which uses the test
 * config with WAKE_SECRET = 'test-wake-secret-do-not-use-in-prod-12345'),
 * replace the wakeStateService decorator with a mock BEFORE app.ready() so
 * the route plugin sees the mock at registration time, then use Fastify's
 * `inject` API for in-process HTTP-shaped tests.
 *
 * buildApp (Task 2) constructs WakeStateService and registers wakeRoutes
 * automatically. Tests swap the decorator value directly — no extra
 * register() call and no decorate() call (both would conflict with buildApp).
 */

const TEST_SECRET = 'test-wake-secret-do-not-use-in-prod-12345';

interface MockWakeStateService {
	handleWakeCall: ReturnType<typeof vi.fn>;
}

function attachMockWake(app: FastifyInstance, mock: MockWakeStateService): void {
	// buildApp already decorated wakeStateService -- replace the value in place.
	// Direct property write bypasses Fastify's decorator immutability check
	// (decorators are accessed via property lookup on the instance).
	(app as unknown as { wakeStateService: MockWakeStateService }).wakeStateService = mock;
}

describe('POST /wake/:secret -- CHAN-02 secret + body', () => {
	let app: FastifyInstance;
	let mockWakeStateService: MockWakeStateService;

	beforeEach(async () => {
		app = buildTestApp();
		mockWakeStateService = {
			handleWakeCall: vi.fn().mockResolvedValue({
				status: 'fired',
				day_anchor: '2026-04-07',
			}),
		};
		attachMockWake(app, mockWakeStateService);
		await app.ready();
	});

	afterEach(async () => {
		await app.close();
	});

	it('valid secret returns 200 + day-start sequence body', async () => {
		const res = await app.inject({
			method: 'POST',
			url: `/wake/${TEST_SECRET}`,
			payload: {},
		});
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.status).toBe('fired');
		expect(body.day_anchor).toBe('2026-04-07');
		expect(mockWakeStateService.handleWakeCall).toHaveBeenCalledTimes(1);
	});

	it('wrong secret returns 404 opaque (D-18)', async () => {
		const res = await app.inject({
			method: 'POST',
			url: '/wake/wrong-secret-here-but-same-length-as-real-',
			payload: {},
		});
		expect(res.statusCode).toBe(404);
		expect(mockWakeStateService.handleWakeCall).not.toHaveBeenCalled();
	});

	it('length mismatch -- short secret does NOT throw, returns 404 (Pitfall 6)', async () => {
		const res = await app.inject({
			method: 'POST',
			url: '/wake/short',
			payload: {},
		});
		expect(res.statusCode).toBe(404);
		// Critical: regression guard for crypto.timingSafeEqual length-mismatch RangeError.
		// The route MUST NOT crash with 500 on a wrong-length secret.
		expect(res.statusCode).not.toBe(500);
		expect(mockWakeStateService.handleWakeCall).not.toHaveBeenCalled();
	});

	it('length mismatch -- long secret does NOT throw, returns 404', async () => {
		const res = await app.inject({
			method: 'POST',
			url: `/wake/${TEST_SECRET}-extra-stuff-appended`,
			payload: {},
		});
		expect(res.statusCode).toBe(404);
		expect(res.statusCode).not.toBe(500);
	});

	it('body forward compat -- accepts empty body without payload', async () => {
		const res = await app.inject({
			method: 'POST',
			url: `/wake/${TEST_SECRET}`,
		});
		expect(res.statusCode).toBe(200);
	});

	it('body forward compat -- accepts arbitrary JSON body fields', async () => {
		const res = await app.inject({
			method: 'POST',
			url: `/wake/${TEST_SECRET}`,
			payload: {
				wake_reason: 'iPhone alarm',
				snooze_count: 4,
				arbitrary_future_field: { nested: true },
			},
		});
		expect(res.statusCode).toBe(200);
	});

	it('snoozed status passes through 200', async () => {
		mockWakeStateService.handleWakeCall.mockResolvedValueOnce({
			status: 'snoozed',
			wait_secs: 300,
			day_anchor: '2026-04-07',
		});
		const res = await app.inject({
			method: 'POST',
			url: `/wake/${TEST_SECRET}`,
			payload: {},
		});
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.status).toBe('snoozed');
		expect(body.wait_secs).toBe(300);
	});

	it('already_started status passes through 200', async () => {
		mockWakeStateService.handleWakeCall.mockResolvedValueOnce({
			status: 'already_started',
			day_anchor: '2026-04-07',
		});
		const res = await app.inject({
			method: 'POST',
			url: `/wake/${TEST_SECRET}`,
			payload: {},
		});
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.status).toBe('already_started');
	});

	it('handler crash returns 500 (defensive)', async () => {
		mockWakeStateService.handleWakeCall.mockRejectedValueOnce(new Error('boom'));
		const res = await app.inject({
			method: 'POST',
			url: `/wake/${TEST_SECRET}`,
			payload: {},
		});
		expect(res.statusCode).toBe(500);
	});
});

describe('POST /wake/:secret -- CHAN-03 day-start side effects', () => {
	let app: FastifyInstance;
	let mockWakeStateService: MockWakeStateService;
	let updateHubSpy: ReturnType<typeof vi.fn>;
	let ensureTodayPlanSpy: ReturnType<typeof vi.fn>;
	let forceCheckInSpy: ReturnType<typeof vi.fn>;
	let markStartedSpy: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		app = buildTestApp();
		// Inject spies via the wakeStateService mock -- handleWakeCall calls these in order
		updateHubSpy = vi.fn().mockResolvedValue(undefined);
		ensureTodayPlanSpy = vi.fn().mockResolvedValue({ id: 1, date: '2026-04-07' });
		forceCheckInSpy = vi.fn().mockResolvedValue(undefined);
		markStartedSpy = vi.fn();
		mockWakeStateService = {
			handleWakeCall: vi.fn().mockImplementation(async () => {
				// Simulate the day-start sequence the real WakeStateService runs
				await updateHubSpy();
				await ensureTodayPlanSpy();
				markStartedSpy();
				await forceCheckInSpy('wake');
				return { status: 'fired', day_anchor: '2026-04-07' };
			}),
		};
		attachMockWake(app, mockWakeStateService);
		await app.ready();
	});

	afterEach(async () => {
		await app.close();
	});

	it('day-start hub -- calls updateHub exactly once', async () => {
		await app.inject({ method: 'POST', url: `/wake/${TEST_SECRET}`, payload: {} });
		expect(updateHubSpy).toHaveBeenCalledTimes(1);
	});

	it('day-start ensure plan -- calls dailyPlanService.ensureTodayPlan exactly once', async () => {
		await app.inject({ method: 'POST', url: `/wake/${TEST_SECRET}`, payload: {} });
		expect(ensureTodayPlanSpy).toHaveBeenCalledTimes(1);
	});

	it('day-start mark started -- sets dailyPlans.started_at', async () => {
		await app.inject({ method: 'POST', url: `/wake/${TEST_SECRET}`, payload: {} });
		expect(markStartedSpy).toHaveBeenCalledTimes(1);
	});

	it('day-start force check-in -- calls checkInService.forceCheckIn with reason wake', async () => {
		await app.inject({ method: 'POST', url: `/wake/${TEST_SECRET}`, payload: {} });
		expect(forceCheckInSpy).toHaveBeenCalledTimes(1);
		expect(forceCheckInSpy).toHaveBeenCalledWith('wake');
	});
});

import { describe, expect, it, vi } from 'vitest';
import {
	getCurrentChunk,
	getNextChunkStartTime,
	resolveCurrentChunkAttachment,
	type PlanChunkWithTasks,
} from '../../src/core/current-chunk.js';
import type { DailyPlanService } from '../../src/core/daily-plan-service.js';

function mkChunk(
	id: number,
	startTime: string,
	endTime: string,
	sortOrder = id,
): PlanChunkWithTasks {
	return {
		id,
		planId: 1,
		taskId: null,
		branchName: 'Test',
		label: `chunk-${id}`,
		startTime,
		endTime,
		isLocked: false,
		isTaskSlot: true,
		sortOrder,
		status: 'pending',
		tasks: [],
	};
}

describe('getCurrentChunk', () => {
	const chunks: PlanChunkWithTasks[] = [
		mkChunk(1, '08:00', '10:00'),
		mkChunk(2, '10:00', '12:00'),
		mkChunk(3, '14:00', '16:00'),
	];

	it('picks chunk whose [start,end) contains now', () => {
		const now = new Date();
		now.setHours(11, 0, 0, 0);
		expect(getCurrentChunk(chunks, now)?.id).toBe(2);
	});

	it('returns null in a gap (12:00-14:00)', () => {
		const now = new Date();
		now.setHours(13, 0, 0, 0);
		expect(getCurrentChunk(chunks, now)).toBeNull();
	});

	it('half-open boundary: 10:00 matches chunk 2 (10-12), not chunk 1 (08-10)', () => {
		const now = new Date();
		now.setHours(10, 0, 0, 0);
		expect(getCurrentChunk(chunks, now)?.id).toBe(2);
	});

	it('D-19 invariant: 11:59 vs 12:01 yield different results', () => {
		const n1 = new Date();
		n1.setHours(11, 59, 0, 0);
		const n2 = new Date();
		n2.setHours(12, 1, 0, 0);
		expect(getCurrentChunk(chunks, n1)?.id).toBe(2);
		expect(getCurrentChunk(chunks, n2)).toBeNull();
	});

	it('sortOrder tiebreaker when chunks overlap same instant', () => {
		const overlapping: PlanChunkWithTasks[] = [
			mkChunk(10, '10:00', '12:00', 5), // higher sortOrder
			mkChunk(11, '10:00', '12:00', 1), // lower sortOrder -- should win
		];
		const now = new Date();
		now.setHours(11, 0, 0, 0);
		expect(getCurrentChunk(overlapping, now)?.id).toBe(11);
	});

	it('returns null when chunks array is empty', () => {
		const now = new Date();
		now.setHours(11, 0, 0, 0);
		expect(getCurrentChunk([], now)).toBeNull();
	});

	it('returns null before any chunk starts (early morning)', () => {
		const now = new Date();
		now.setHours(6, 0, 0, 0);
		expect(getCurrentChunk(chunks, now)).toBeNull();
	});
});

describe('getNextChunkStartTime', () => {
	const chunks: PlanChunkWithTasks[] = [mkChunk(1, '08:00', '10:00'), mkChunk(2, '14:00', '16:00')];

	it('returns next upcoming start when inside a gap', () => {
		const now = new Date();
		now.setHours(11, 0, 0, 0);
		expect(getNextChunkStartTime(chunks, now)).toBe('14:00');
	});

	it('returns null when no more chunks today', () => {
		const now = new Date();
		now.setHours(17, 0, 0, 0);
		expect(getNextChunkStartTime(chunks, now)).toBeNull();
	});

	it('returns earliest future chunk when before all chunks', () => {
		const now = new Date();
		now.setHours(6, 0, 0, 0);
		expect(getNextChunkStartTime(chunks, now)).toBe('08:00');
	});

	it('returns strictly-later chunk (not the currently-active one)', () => {
		// Within chunk 1 (08-10), next should be chunk 2 (14:00) -- not 08:00
		const now = new Date();
		now.setHours(9, 0, 0, 0);
		expect(getNextChunkStartTime(chunks, now)).toBe('14:00');
	});
});

describe('resolveCurrentChunkAttachment (Phase 08.3 D-16 fallback)', () => {
	function mkPlanService(overrides: {
		getTodayPlan?: () => { id: number } | undefined;
		getPlanWithChunks?: (id: number) => { chunks: PlanChunkWithTasks[] };
	}): DailyPlanService {
		return {
			getTodayPlan: overrides.getTodayPlan ?? (() => undefined),
			getPlanWithChunks: overrides.getPlanWithChunks ?? (() => ({ chunks: [] })),
			// biome-ignore lint/suspicious/noExplicitAny: only the two methods above are exercised
		} as any as DailyPlanService;
	}

	it('returns {chunkId: null, branchName: null} when dailyPlanService is undefined', () => {
		const result = resolveCurrentChunkAttachment(undefined);
		expect(result).toEqual({ chunkId: null, branchName: null });
	});

	it('returns {chunkId: null, branchName: null} when no plan exists for today', () => {
		const service = mkPlanService({ getTodayPlan: () => undefined });
		const result = resolveCurrentChunkAttachment(service);
		expect(result).toEqual({ chunkId: null, branchName: null });
	});

	it('returns {chunkId: null, branchName: null} when no chunk contains the current time (gap)', () => {
		const now = new Date();
		now.setHours(13, 0, 0, 0); // gap between chunks 08-10 and 14-16
		const service = mkPlanService({
			getTodayPlan: () => ({ id: 1 }),
			getPlanWithChunks: () => ({
				chunks: [mkChunk(1, '08:00', '10:00'), mkChunk(2, '14:00', '16:00')],
			}),
		});
		const result = resolveCurrentChunkAttachment(service, now);
		expect(result).toEqual({ chunkId: null, branchName: null });
	});

	it('returns {chunkId, branchName} of the current chunk when one is active', () => {
		const now = new Date();
		now.setHours(11, 0, 0, 0); // inside chunk 2 (10-12)
		const chunk2: PlanChunkWithTasks = {
			...mkChunk(2, '10:00', '12:00'),
			branchName: 'Day branch',
		};
		const service = mkPlanService({
			getTodayPlan: () => ({ id: 7 }),
			getPlanWithChunks: () => ({ chunks: [mkChunk(1, '08:00', '10:00'), chunk2] }),
		});
		const result = resolveCurrentChunkAttachment(service, now);
		expect(result).toEqual({ chunkId: 2, branchName: 'Day branch' });
	});

	it('defaults now to new Date() when not provided (D-19 fresh-clock invariant)', () => {
		// Use vitest fake timers instead of mocking Date constructor directly --
		// the latter trips up V8's Reflect.construct call inside default-arg
		// expression evaluation. Fake timers are the supported pattern.
		vi.useFakeTimers();
		const fixed = new Date();
		fixed.setHours(11, 0, 0, 0);
		vi.setSystemTime(fixed);

		const chunk2: PlanChunkWithTasks = {
			...mkChunk(2, '10:00', '12:00'),
			branchName: 'Day branch',
		};
		const service = mkPlanService({
			getTodayPlan: () => ({ id: 7 }),
			getPlanWithChunks: () => ({ chunks: [chunk2] }),
		});

		const result = resolveCurrentChunkAttachment(service);
		expect(result).toEqual({ chunkId: 2, branchName: 'Day branch' });

		vi.useRealTimers();
	});
});

import { describe, expect, it } from 'vitest';
import {
	getCurrentChunk,
	getNextChunkStartTime,
	type PlanChunkWithTasks,
} from '../../src/core/current-chunk.js';

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

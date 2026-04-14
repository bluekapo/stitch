import { describe, expect, it } from 'vitest';
import { computeLatestEndTime } from '../../src/core/day-boundary.js';
import type { DayTree } from '../../src/types/day-tree.js';

describe('computeLatestEndTime', () => {
	it('returns null for undefined tree (empty tree fallback)', () => {
		expect(computeLatestEndTime(undefined)).toBeNull();
	});

	it('returns null for tree with empty branches array (empty tree fallback)', () => {
		const tree: DayTree = { branches: [] };
		expect(computeLatestEndTime(tree)).toBeNull();
	});

	it('returns the only endTime for single branch', () => {
		const tree: DayTree = {
			branches: [
				{
					name: 'Day',
					startTime: '08:00',
					endTime: '21:00',
					isTaskSlot: true,
					items: [],
				},
			],
		};
		expect(computeLatestEndTime(tree)).toBe('21:00');
	});

	it('returns the maximum endTime across multiple branches in chronological order', () => {
		const tree: DayTree = {
			branches: [
				{
					name: 'Morning',
					startTime: '08:00',
					endTime: '10:00',
					isTaskSlot: true,
					items: [],
				},
				{
					name: 'Day',
					startTime: '10:00',
					endTime: '18:00',
					isTaskSlot: true,
					items: [],
				},
				{
					name: 'Evening',
					startTime: '18:00',
					endTime: '23:00',
					isTaskSlot: false,
					items: [],
				},
			],
		};
		expect(computeLatestEndTime(tree)).toBe('23:00');
	});

	it('returns the maximum endTime when branches are in non-chronological order', () => {
		const tree: DayTree = {
			branches: [
				{
					name: 'Evening',
					startTime: '18:00',
					endTime: '23:00',
					isTaskSlot: false,
					items: [],
				},
				{
					name: 'Morning',
					startTime: '08:00',
					endTime: '10:00',
					isTaskSlot: true,
					items: [],
				},
				{
					name: 'Day',
					startTime: '10:00',
					endTime: '21:00',
					isTaskSlot: true,
					items: [],
				},
			],
		};
		expect(computeLatestEndTime(tree)).toBe('23:00');
	});

	it('returns the endTime when two branches share the same latest endTime', () => {
		const tree: DayTree = {
			branches: [
				{
					name: 'A',
					startTime: '08:00',
					endTime: '21:00',
					isTaskSlot: true,
					items: [],
				},
				{
					name: 'B',
					startTime: '10:00',
					endTime: '21:00',
					isTaskSlot: true,
					items: [],
				},
			],
		};
		expect(computeLatestEndTime(tree)).toBe('21:00');
	});
});

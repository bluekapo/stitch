import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { DayTreeLlmSchema, DayTreeCycleSchema, DayTreeItemSchema } from '../../src/schemas/day-tree.js';
import { dayTrees } from '../../src/db/schema.js';

const SAMPLE_TREE = {
	cycles: [
		{ name: 'Wake up', startTime: '07:00', endTime: '08:00', isTaskSlot: false, items: [{ label: 'Wake up', type: 'fixed' as const }] },
		{ name: 'Morning duties', startTime: '08:00', endTime: '10:00', isTaskSlot: true },
		{ name: 'Day cycle', startTime: '10:00', endTime: '21:00', isTaskSlot: true, items: [{ label: 'Games allowed 16-21', type: 'rule' as const }] },
		{ name: 'Dinner', startTime: '21:00', endTime: '21:45', isTaskSlot: false, items: [{ label: 'Dinner', type: 'fixed' as const }] },
		{ name: 'Night duties', startTime: '21:45', endTime: '22:30', isTaskSlot: true },
		{ name: 'Sleep', startTime: '22:30', endTime: '07:00', isTaskSlot: false, items: [{ label: 'Sleep', type: 'fixed' as const }] },
	],
};

describe('DayTree schemas', () => {
	it('DayTreeItemSchema validates a fixed item', () => {
		const result = DayTreeItemSchema.safeParse({ label: 'Wake up', type: 'fixed' });
		expect(result.success).toBe(true);
	});

	it('DayTreeItemSchema validates a rule item', () => {
		const result = DayTreeItemSchema.safeParse({ label: 'Games allowed', type: 'rule' });
		expect(result.success).toBe(true);
	});

	it('DayTreeItemSchema rejects invalid type enum', () => {
		const result = DayTreeItemSchema.safeParse({ label: 'Test', type: 'invalid' });
		expect(result.success).toBe(false);
	});

	it('DayTreeCycleSchema validates a cycle with items', () => {
		const result = DayTreeCycleSchema.safeParse({
			name: 'Wake up',
			startTime: '07:00',
			endTime: '08:00',
			isTaskSlot: false,
			items: [{ label: 'Wake up', type: 'fixed' }],
		});
		expect(result.success).toBe(true);
	});

	it('DayTreeCycleSchema validates a cycle without items', () => {
		const result = DayTreeCycleSchema.safeParse({
			name: 'Morning duties',
			startTime: '08:00',
			endTime: '10:00',
			isTaskSlot: true,
		});
		expect(result.success).toBe(true);
	});

	it('DayTreeCycleSchema rejects cycle missing name', () => {
		const result = DayTreeCycleSchema.safeParse({
			startTime: '07:00',
			endTime: '08:00',
			isTaskSlot: false,
		});
		expect(result.success).toBe(false);
	});

	it('schema validates correct day tree structure', () => {
		const result = DayTreeLlmSchema.safeParse(SAMPLE_TREE);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.cycles).toHaveLength(6);
		}
	});

	it('schema rejects invalid structure', () => {
		const result = DayTreeLlmSchema.safeParse({ cycles: [{ name: 'x' }] });
		expect(result.success).toBe(false);
	});
});

describe('DayTree DB table', () => {
	let db: ReturnType<typeof createTestDb>;

	beforeEach(() => {
		db = createTestDb();
	});

	it('createTestDb creates day_trees table without error', () => {
		const result = db.select().from(dayTrees).all();
		expect(result).toEqual([]);
	});
});

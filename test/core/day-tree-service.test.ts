import { beforeEach, describe, expect, it } from 'vitest';
import { DayTreeService } from '../../src/core/day-tree-service.js';
import { dayTrees } from '../../src/db/schema.js';
import { MockLlmProvider } from '../../src/providers/mock.js';
import {
	DayTreeBranchSchema,
	DayTreeItemSchema,
	DayTreeLlmSchema,
} from '../../src/schemas/day-tree.js';
import { createTestDb } from '../helpers/db.js';
import { createTestLogger } from '../helpers/logger.js';

const SAMPLE_TREE = {
	branches: [
		{
			name: 'Wake up',
			startTime: '07:00',
			endTime: '08:00',
			isTaskSlot: false,
			items: [{ label: 'Wake up', type: 'fixed' as const }],
		},
		{ name: 'Morning duties', startTime: '08:00', endTime: '10:00', isTaskSlot: true },
		{
			name: 'Day branch',
			startTime: '10:00',
			endTime: '21:00',
			isTaskSlot: true,
			items: [{ label: 'Games allowed 16-21', type: 'rule' as const }],
		},
		{
			name: 'Dinner',
			startTime: '21:00',
			endTime: '21:45',
			isTaskSlot: false,
			items: [{ label: 'Dinner', type: 'fixed' as const }],
		},
		{ name: 'Night duties', startTime: '21:45', endTime: '22:30', isTaskSlot: true },
		{
			name: 'Sleep',
			startTime: '22:30',
			endTime: '07:00',
			isTaskSlot: false,
			items: [{ label: 'Sleep', type: 'fixed' as const }],
		},
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

	it('DayTreeBranchSchema validates a branch with items', () => {
		const result = DayTreeBranchSchema.safeParse({
			name: 'Wake up',
			startTime: '07:00',
			endTime: '08:00',
			isTaskSlot: false,
			items: [{ label: 'Wake up', type: 'fixed' }],
		});
		expect(result.success).toBe(true);
	});

	it('DayTreeBranchSchema validates a branch without items', () => {
		const result = DayTreeBranchSchema.safeParse({
			name: 'Morning duties',
			startTime: '08:00',
			endTime: '10:00',
			isTaskSlot: true,
		});
		expect(result.success).toBe(true);
	});

	it('DayTreeBranchSchema rejects branch missing name', () => {
		const result = DayTreeBranchSchema.safeParse({
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
			expect(result.data.branches).toHaveLength(6);
		}
	});

	it('schema rejects invalid structure', () => {
		const result = DayTreeLlmSchema.safeParse({ branches: [{ name: 'x' }] });
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

describe('DayTreeService', () => {
	let db: ReturnType<typeof createTestDb>;
	let llm: MockLlmProvider;
	let service: DayTreeService;

	const MODIFIED_TREE = {
		branches: [
			{
				name: 'Wake up',
				startTime: '07:00',
				endTime: '08:00',
				isTaskSlot: false,
				items: [{ label: 'Wake up', type: 'fixed' as const }],
			},
			{ name: 'Morning duties', startTime: '08:00', endTime: '10:00', isTaskSlot: true },
			{ name: 'Day branch', startTime: '10:00', endTime: '20:00', isTaskSlot: true },
			{
				name: 'Dinner',
				startTime: '20:00',
				endTime: '20:45',
				isTaskSlot: false,
				items: [{ label: 'Dinner', type: 'fixed' as const }],
			},
			{ name: 'Night duties', startTime: '20:45', endTime: '22:30', isTaskSlot: true },
			{
				name: 'Sleep',
				startTime: '22:30',
				endTime: '07:00',
				isTaskSlot: false,
				items: [{ label: 'Sleep', type: 'fixed' as const }],
			},
		],
	};

	beforeEach(() => {
		db = createTestDb();
		llm = new MockLlmProvider();
		service = new DayTreeService(db, llm, createTestLogger());
	});

	it('getTree returns undefined when no tree exists', () => {
		expect(service.getTree()).toBeUndefined();
	});

	it('setTree calls LLM and stores tree', async () => {
		llm.setFixture('day_tree', SAMPLE_TREE);
		const result = await service.setTree('wake up at 7, morning duties...');
		expect(result.branches).toHaveLength(6);
		expect(result.branches[0].name).toBe('Wake up');

		const stored = service.getTree();
		expect(stored).toBeDefined();
		expect(stored!.branches).toHaveLength(6);
	});

	it('setTree replaces existing tree (only one row)', async () => {
		llm.setFixture('day_tree', SAMPLE_TREE);
		await service.setTree('first tree');

		llm.setFixture('day_tree', MODIFIED_TREE);
		await service.setTree('second tree');

		const stored = service.getTree();
		expect(stored).toBeDefined();
		expect(stored!.branches[2].endTime).toBe('20:00');

		// Verify only one row in DB
		const rows = db.select().from(dayTrees).all();
		expect(rows).toHaveLength(1);
	});

	it('editTree modifies existing tree', async () => {
		llm.setFixture('day_tree', SAMPLE_TREE);
		await service.setTree('my day...');

		llm.setFixture('day_tree', MODIFIED_TREE);
		const result = await service.editTree('move dinner to 20:00');

		expect(result.branches[3].startTime).toBe('20:00');
		expect(result.branches[3].name).toBe('Dinner');
	});

	it('editTree throws when no tree exists', async () => {
		await expect(service.editTree('anything')).rejects.toThrow(
			'No day tree set. Use "tree <description>" first.',
		);
	});

	it('getTreeRow returns undefined when no tree exists', () => {
		expect(service.getTreeRow()).toBeUndefined();
	});

	it('getTreeRow returns id and tree when tree exists', async () => {
		llm.setFixture('day_tree', SAMPLE_TREE);
		await service.setTree('my day...');

		const row = service.getTreeRow();
		expect(row).toBeDefined();
		expect(typeof row!.id).toBe('number');
		expect(row!.tree.branches).toHaveLength(6);
	});

	it('LLM calls use correct options', async () => {
		// The mock validates via schemaName -- if 'day_tree' fixture not set, it throws
		llm.setFixture('day_tree', SAMPLE_TREE);
		const result = await service.setTree('test');
		// If we got here, schemaName='day_tree' was used correctly
		expect(result).toBeDefined();
	});
});

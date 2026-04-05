import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { createBlueprintSchema, createCycleSchema, createTimeBlockSchema } from '../../src/types/blueprint.js';
import { blueprints, blueprintCycles, blueprintTimeBlocks } from '../../src/db/schema.js';

describe('Blueprint schema and types', () => {
	let db: ReturnType<typeof createTestDb>;

	beforeEach(() => {
		db = createTestDb();
	});

	it('createTestDb creates blueprint tables without error', () => {
		// If we get here, tables were created successfully
		const result = db.select().from(blueprints).all();
		expect(result).toEqual([]);
	});

	it('inserting a blueprint row returns { id, name }', () => {
		const rows = db.insert(blueprints).values({ name: 'Weekday' })
			.returning({ id: blueprints.id, name: blueprints.name }).all();
		expect(rows[0]).toEqual({ id: 1, name: 'Weekday' });
	});

	it('inserting a cycle with invalid blueprintId fails (FK constraint)', () => {
		expect(() => {
			db.insert(blueprintCycles).values({
				blueprintId: 999,
				name: 'Morning',
				startTime: '07:00',
				endTime: '09:00',
			}).run();
		}).toThrow();
	});

	it('deleting a blueprint cascades to cycles and time blocks', () => {
		const [bp] = db.insert(blueprints).values({ name: 'Test' })
			.returning({ id: blueprints.id }).all();
		const [cycle] = db.insert(blueprintCycles).values({
			blueprintId: bp.id,
			name: 'Morning',
			startTime: '07:00',
			endTime: '09:00',
		}).returning({ id: blueprintCycles.id }).all();
		db.insert(blueprintTimeBlocks).values({
			cycleId: cycle.id,
			startTime: '07:00',
			endTime: '07:30',
		}).run();

		db.delete(blueprints).run();

		expect(db.select().from(blueprintCycles).all()).toEqual([]);
		expect(db.select().from(blueprintTimeBlocks).all()).toEqual([]);
	});

	describe('Zod createBlueprintSchema', () => {
		it('validates name 1-100 chars', () => {
			expect(createBlueprintSchema.safeParse({ name: 'Weekday' }).success).toBe(true);
			expect(createBlueprintSchema.safeParse({ name: 'A'.repeat(100) }).success).toBe(true);
		});

		it('rejects empty name', () => {
			expect(createBlueprintSchema.safeParse({ name: '' }).success).toBe(false);
		});

		it('rejects name over 100 chars', () => {
			expect(createBlueprintSchema.safeParse({ name: 'A'.repeat(101) }).success).toBe(false);
		});
	});

	describe('Zod createCycleSchema', () => {
		it('validates HH:MM format for startTime/endTime', () => {
			const valid = createCycleSchema.safeParse({
				blueprintId: 1,
				name: 'Morning',
				startTime: '07:00',
				endTime: '09:00',
			});
			expect(valid.success).toBe(true);
		});

		it('rejects "25:00"', () => {
			const invalid = createCycleSchema.safeParse({
				blueprintId: 1,
				name: 'Morning',
				startTime: '25:00',
				endTime: '09:00',
			});
			expect(invalid.success).toBe(false);
		});

		it('rejects invalid minute "07:60"', () => {
			const invalid = createCycleSchema.safeParse({
				blueprintId: 1,
				name: 'Morning',
				startTime: '07:60',
				endTime: '09:00',
			});
			expect(invalid.success).toBe(false);
		});
	});

	describe('Zod createTimeBlockSchema', () => {
		it('validates HH:MM format', () => {
			const valid = createTimeBlockSchema.safeParse({
				cycleId: 1,
				startTime: '07:00',
				endTime: '07:30',
			});
			expect(valid.success).toBe(true);
		});

		it('isSlot defaults to true', () => {
			const result = createTimeBlockSchema.parse({
				cycleId: 1,
				startTime: '07:00',
				endTime: '07:30',
			});
			expect(result.isSlot).toBe(true);
		});

		it('label defaults to undefined', () => {
			const result = createTimeBlockSchema.parse({
				cycleId: 1,
				startTime: '07:00',
				endTime: '07:30',
			});
			expect(result.label).toBeUndefined();
		});
	});
});

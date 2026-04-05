import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { createBlueprintSchema, createCycleSchema, createTimeBlockSchema } from '../../src/types/blueprint.js';
import { blueprints, blueprintCycles, blueprintTimeBlocks } from '../../src/db/schema.js';
import { BlueprintService } from '../../src/core/blueprint-service.js';

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

describe('BlueprintService', () => {
	let db: ReturnType<typeof createTestDb>;
	let service: BlueprintService;

	beforeEach(() => {
		db = createTestDb();
		service = new BlueprintService(db);
	});

	it('createBlueprint("Weekday") returns { id: 1, name: "Weekday" }', () => {
		const result = service.createBlueprint({ name: 'Weekday' });
		expect(result).toEqual({ id: 1, name: 'Weekday' });
	});

	it('addCycle returns { id }', () => {
		const bp = service.createBlueprint({ name: 'Test' });
		const cycle = service.addCycle({
			blueprintId: bp.id,
			name: 'Morning',
			startTime: '07:00',
			endTime: '09:00',
		});
		expect(cycle).toEqual({ id: 1 });
	});

	it('addTimeBlock with explicit isSlot=false returns { id }', () => {
		const bp = service.createBlueprint({ name: 'Test' });
		const cycle = service.addCycle({
			blueprintId: bp.id,
			name: 'Morning',
			startTime: '07:00',
			endTime: '09:00',
		});
		const block = service.addTimeBlock({
			cycleId: cycle.id,
			label: 'Shower',
			startTime: '07:00',
			endTime: '07:30',
			isSlot: false,
		});
		expect(block).toEqual({ id: 1 });
	});

	it('addTimeBlock defaults isSlot=true and label=null', () => {
		const bp = service.createBlueprint({ name: 'Test' });
		const cycle = service.addCycle({
			blueprintId: bp.id,
			name: 'Morning',
			startTime: '07:00',
			endTime: '09:00',
		});
		service.addTimeBlock({
			cycleId: cycle.id,
			startTime: '07:30',
			endTime: '08:00',
		});
		const full = service.getFullBlueprint(bp.id);
		expect(full?.cycles[0].timeBlocks[0].isSlot).toBe(true);
		expect(full?.cycles[0].timeBlocks[0].label).toBeNull();
	});

	it('getFullBlueprint returns nested object sorted by sortOrder', () => {
		const bp = service.createBlueprint({ name: 'Weekday' });
		service.addCycle({
			blueprintId: bp.id,
			name: 'Afternoon',
			startTime: '12:00',
			endTime: '17:00',
			sortOrder: 2,
		});
		const c1 = service.addCycle({
			blueprintId: bp.id,
			name: 'Morning',
			startTime: '07:00',
			endTime: '12:00',
			sortOrder: 1,
		});
		service.addTimeBlock({
			cycleId: c1.id,
			label: 'Second',
			startTime: '08:00',
			endTime: '09:00',
			sortOrder: 2,
		});
		service.addTimeBlock({
			cycleId: c1.id,
			label: 'First',
			startTime: '07:00',
			endTime: '08:00',
			sortOrder: 1,
		});

		const full = service.getFullBlueprint(bp.id);
		expect(full).toBeDefined();
		expect(full!.name).toBe('Weekday');
		expect(full!.cycles).toHaveLength(2);
		expect(full!.cycles[0].name).toBe('Morning');
		expect(full!.cycles[1].name).toBe('Afternoon');
		expect(full!.cycles[0].timeBlocks).toHaveLength(2);
		expect(full!.cycles[0].timeBlocks[0].label).toBe('First');
		expect(full!.cycles[0].timeBlocks[1].label).toBe('Second');
	});

	it('setActive sets target to active and all others to inactive', () => {
		const bp1 = service.createBlueprint({ name: 'Weekday' });
		const bp2 = service.createBlueprint({ name: 'Weekend' });

		service.setActive(bp1.id);
		expect(service.getActiveBlueprint()?.id).toBe(bp1.id);

		service.setActive(bp2.id);
		const active = service.getActiveBlueprint();
		expect(active?.id).toBe(bp2.id);

		// Verify bp1 is no longer active
		const list = service.listBlueprints();
		const bp1Status = list.find(b => b.id === bp1.id);
		expect(bp1Status?.isActive).toBe(false);
	});

	it('getActiveBlueprint returns undefined if none active', () => {
		service.createBlueprint({ name: 'Test' });
		expect(service.getActiveBlueprint()).toBeUndefined();
	});

	it('deleteBlueprint removes blueprint and cascaded cycles/blocks', () => {
		const bp = service.createBlueprint({ name: 'Test' });
		const cycle = service.addCycle({
			blueprintId: bp.id,
			name: 'Morning',
			startTime: '07:00',
			endTime: '09:00',
		});
		service.addTimeBlock({
			cycleId: cycle.id,
			startTime: '07:00',
			endTime: '07:30',
		});

		service.deleteBlueprint(bp.id);

		expect(service.listBlueprints()).toEqual([]);
		expect(db.select().from(blueprintCycles).all()).toEqual([]);
		expect(db.select().from(blueprintTimeBlocks).all()).toEqual([]);
	});

	it('addCycle with nonexistent blueprintId throws error', () => {
		expect(() => {
			service.addCycle({
				blueprintId: 999,
				name: 'Morning',
				startTime: '07:00',
				endTime: '09:00',
			});
		}).toThrow('Blueprint not found.');
	});

	it('addTimeBlock with nonexistent cycleId throws error', () => {
		expect(() => {
			service.addTimeBlock({
				cycleId: 999,
				startTime: '07:00',
				endTime: '07:30',
			});
		}).toThrow('Cycle not found.');
	});

	it('deleteBlueprint with nonexistent id throws error', () => {
		expect(() => {
			service.deleteBlueprint(999);
		}).toThrow('Blueprint not found.');
	});

	it('listBlueprints returns all blueprints', () => {
		service.createBlueprint({ name: 'Weekday' });
		service.createBlueprint({ name: 'Weekend' });
		const list = service.listBlueprints();
		expect(list).toHaveLength(2);
		expect(list[0].name).toBe('Weekday');
		expect(list[1].name).toBe('Weekend');
	});
});

import { eq, sql, asc, inArray } from 'drizzle-orm';
import type { StitchDb } from '../db/index.js';
import { blueprints, blueprintCycles, blueprintTimeBlocks } from '../db/schema.js';
import type { CreateBlueprintInput, CreateCycleInput, CreateTimeBlockInput, FullBlueprint } from '../types/blueprint.js';

export class BlueprintService {
	constructor(private db: StitchDb) {}

	createBlueprint(input: CreateBlueprintInput): { id: number; name: string } {
		const rows = this.db
			.insert(blueprints)
			.values({ name: input.name })
			.returning({ id: blueprints.id, name: blueprints.name })
			.all();
		return rows[0];
	}

	addCycle(input: CreateCycleInput): { id: number } {
		const bp = this.db.select({ id: blueprints.id }).from(blueprints)
			.where(eq(blueprints.id, input.blueprintId)).get();
		if (!bp) throw new Error('Blueprint not found.');

		const rows = this.db
			.insert(blueprintCycles)
			.values({
				blueprintId: input.blueprintId,
				name: input.name,
				startTime: input.startTime,
				endTime: input.endTime,
				sortOrder: input.sortOrder ?? 0,
			})
			.returning({ id: blueprintCycles.id })
			.all();
		return rows[0];
	}

	addTimeBlock(input: CreateTimeBlockInput): { id: number } {
		const cycle = this.db.select({ id: blueprintCycles.id }).from(blueprintCycles)
			.where(eq(blueprintCycles.id, input.cycleId)).get();
		if (!cycle) throw new Error('Cycle not found.');

		const rows = this.db
			.insert(blueprintTimeBlocks)
			.values({
				cycleId: input.cycleId,
				label: input.label ?? null,
				startTime: input.startTime,
				endTime: input.endTime,
				isSlot: input.isSlot ?? true,
				sortOrder: input.sortOrder ?? 0,
			})
			.returning({ id: blueprintTimeBlocks.id })
			.all();
		return rows[0];
	}

	getFullBlueprint(id: number): FullBlueprint | undefined {
		const bp = this.db.select().from(blueprints)
			.where(eq(blueprints.id, id)).get();
		if (!bp) return undefined;

		const cycles = this.db.select().from(blueprintCycles)
			.where(eq(blueprintCycles.blueprintId, id))
			.orderBy(asc(blueprintCycles.sortOrder))
			.all();

		const cycleIds = cycles.map(c => c.id);
		const allBlocks = cycleIds.length > 0
			? this.db.select().from(blueprintTimeBlocks)
				.where(inArray(blueprintTimeBlocks.cycleId, cycleIds))
				.orderBy(asc(blueprintTimeBlocks.sortOrder))
				.all()
			: [];

		const blocksByCycle = new Map<number, typeof allBlocks>();
		for (const block of allBlocks) {
			const list = blocksByCycle.get(block.cycleId) ?? [];
			list.push(block);
			blocksByCycle.set(block.cycleId, list);
		}

		return {
			id: bp.id,
			name: bp.name,
			isActive: bp.isActive,
			cycles: cycles.map(c => ({
				id: c.id,
				name: c.name,
				startTime: c.startTime,
				endTime: c.endTime,
				sortOrder: c.sortOrder,
				timeBlocks: (blocksByCycle.get(c.id) ?? []).map(b => ({
					id: b.id,
					label: b.label,
					startTime: b.startTime,
					endTime: b.endTime,
					isSlot: b.isSlot,
					sortOrder: b.sortOrder,
				})),
			})),
		};
	}

	getActiveBlueprint(): FullBlueprint | undefined {
		const bp = this.db.select().from(blueprints)
			.where(eq(blueprints.isActive, true)).get();
		if (!bp) return undefined;
		return this.getFullBlueprint(bp.id);
	}

	setActive(id: number): void {
		this.db.update(blueprints)
			.set({ isActive: false })
			.run();
		this.db.update(blueprints)
			.set({ isActive: true, updatedAt: sql`(datetime('now'))` })
			.where(eq(blueprints.id, id))
			.run();
	}

	deleteBlueprint(id: number): void {
		const bp = this.db.select({ id: blueprints.id }).from(blueprints)
			.where(eq(blueprints.id, id)).get();
		if (!bp) throw new Error('Blueprint not found.');
		this.db.delete(blueprints).where(eq(blueprints.id, id)).run();
	}

	listBlueprints(): { id: number; name: string; isActive: boolean }[] {
		return this.db.select({
			id: blueprints.id,
			name: blueprints.name,
			isActive: blueprints.isActive,
		}).from(blueprints).all();
	}
}

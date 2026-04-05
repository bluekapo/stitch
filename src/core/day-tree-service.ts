import type { StitchDb } from '../db/index.js';
import { dayTrees } from '../db/schema.js';
import type { LlmProvider } from '../providers/llm.js';
import { DayTreeLlmSchema } from '../schemas/day-tree.js';
import type { DayTree } from '../types/day-tree.js';

const TREE_SET_SYSTEM_PROMPT = `You are a day planner. Structure the user's day description into a day tree. Each branch represents a time period in the day. Branches with isTaskSlot=true are for assignable tasks. Branches with isTaskSlot=false are fixed activities (dinner, sleep). Items within branches describe fixed activities (type='fixed') or permissions/constraints (type='rule'). Use HH:MM format for all times. Order branches chronologically from earliest to latest.`;

const TREE_EDIT_SYSTEM_PROMPT = `You are a day planner. Modify the existing day tree according to the user's request. Output the complete updated tree. Do not remove branches unless explicitly asked. Use HH:MM format for all times. Order branches chronologically.`;

export class DayTreeService {
	constructor(
		private db: StitchDb,
		private llmProvider: LlmProvider,
	) {}

	getTree(): DayTree | undefined {
		const row = this.db.select().from(dayTrees).get();
		if (!row) return undefined;
		return DayTreeLlmSchema.parse(row.tree);
	}

	getTreeRow(): { id: number; tree: DayTree } | undefined {
		const row = this.db.select().from(dayTrees).get();
		if (!row) return undefined;
		const tree = DayTreeLlmSchema.parse(row.tree);
		return { id: row.id, tree };
	}

	async setTree(description: string): Promise<DayTree> {
		const result = await this.llmProvider.complete({
			messages: [
				{ role: 'system', content: TREE_SET_SYSTEM_PROMPT },
				{ role: 'user', content: description },
			],
			schema: DayTreeLlmSchema,
			schemaName: 'day_tree',
			temperature: 0.3,
			thinking: false,
		});

		// Upsert: delete all existing trees, insert new one
		this.db.delete(dayTrees).run();
		this.db.insert(dayTrees).values({ tree: result }).run();

		return result;
	}

	async editTree(modification: string): Promise<DayTree> {
		const current = this.getTree();
		if (!current) {
			throw new Error('No day tree set. Use "tree <description>" first.');
		}

		const result = await this.llmProvider.complete({
			messages: [
				{ role: 'system', content: TREE_EDIT_SYSTEM_PROMPT },
				{ role: 'user', content: `Current tree:\n${JSON.stringify(current, null, 2)}\n\nModification: ${modification}` },
			],
			schema: DayTreeLlmSchema,
			schemaName: 'day_tree',
			temperature: 0.3,
			thinking: false,
		});

		// Upsert: delete all existing trees, insert new one
		this.db.delete(dayTrees).run();
		this.db.insert(dayTrees).values({ tree: result }).run();

		return result;
	}
}

import type { Logger } from 'pino';
import type { StitchDb } from '../db/index.js';
import { dayTrees } from '../db/schema.js';
import { withSoul } from '../prompts/soul.js';
import type { LlmProvider } from '../providers/llm.js';
import { DayTreeLlmSchema } from '../schemas/day-tree.js';
import type { DayTree } from '../types/day-tree.js';

const TREE_SET_SYSTEM_PROMPT = `You are a day planner. Structure the user's day description into a day tree. Each branch represents a time period in the day. Branches with isTaskSlot=true are for assignable tasks. Branches with isTaskSlot=false are fixed activities (dinner, sleep). Items within branches describe fixed activities (type='fixed') or permissions/constraints (type='rule'). Use HH:MM format for all times. Order branches chronologically from earliest to latest.

Terminology:
- A BRANCH is a time period in the day tree (e.g., "Morning duties 08:00-10:00"). Branches are structural -- they define the skeleton.
- A CHUNK is a group of tasks assigned to a branch during plan generation. You are NOT creating chunks here -- only branches.`;

const TREE_EDIT_SYSTEM_PROMPT = `You are a day planner. Modify the existing day tree according to the user's request. Output the complete updated tree. Do not remove branches unless explicitly asked. Use HH:MM format for all times. Order branches chronologically.

Terminology:
- A BRANCH is a time period. A CHUNK is a group of tasks within a branch. You are editing branches, not chunks.`;

export class DayTreeService {
	// D-12: `logger` REQUIRED.
	constructor(
		private db: StitchDb,
		private llmProvider: LlmProvider,
		private logger: Logger,
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

	async setTree(description: string, reqLogger?: Logger): Promise<DayTree> {
		const log = reqLogger ?? this.logger;
		log.debug({ description }, 'dayTree.setTree:start');
		const result = await this.llmProvider.complete({
			messages: [
				{ role: 'system', content: withSoul(TREE_SET_SYSTEM_PROMPT) },
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

		log.debug({ branches: result.branches.length }, 'dayTree.setTree:done');
		return result;
	}

	async editTree(modification: string, reqLogger?: Logger): Promise<DayTree> {
		const log = reqLogger ?? this.logger;
		log.debug({ modification }, 'dayTree.editTree:start');
		const current = this.getTree();
		if (!current) {
			// D-21 (Phase 12): no free-text path to create a tree exists between
			// Phase 12 and Phase 13. The legacy "tree <description>" regex was
			// removed; conversational tree creation lands in Phase 13.
			throw new Error(
				'No day tree set, Sir. Tree creation will become conversational in the next update — for now, please use the hub to seed a tree.',
			);
		}

		const result = await this.llmProvider.complete({
			messages: [
				{ role: 'system', content: withSoul(TREE_EDIT_SYSTEM_PROMPT) },
				{
					role: 'user',
					content: `Current tree:\n${JSON.stringify(current, null, 2)}\n\nModification: ${modification}`,
				},
			],
			schema: DayTreeLlmSchema,
			schemaName: 'day_tree',
			temperature: 0.3,
			thinking: false,
		});

		// Upsert: delete all existing trees, insert new one
		this.db.delete(dayTrees).run();
		this.db.insert(dayTrees).values({ tree: result }).run();

		log.debug({ branches: result.branches.length }, 'dayTree.editTree:done');

		return result;
	}
}

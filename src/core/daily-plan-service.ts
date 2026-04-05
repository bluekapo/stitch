import { eq, asc } from 'drizzle-orm';
import { format } from 'date-fns';
import type { StitchDb } from '../db/index.js';
import { dailyPlans, planChunks, chunkTasks } from '../db/schema.js';
import type { DayTreeService } from './day-tree-service.js';
import type { TaskService } from './task-service.js';
import type { LlmProvider } from '../providers/llm.js';
import { ChunkPlanLlmSchema } from '../schemas/daily-plan.js';
import type { DailyPlan, PlanChunk, ChunkTask } from '../types/daily-plan.js';
import type { DayTree } from '../types/day-tree.js';

export class DailyPlanService {
	constructor(
		private db: StitchDb,
		private dayTreeService: DayTreeService,
		private taskService: TaskService,
		private llmProvider: LlmProvider,
	) {}

	private getTodayDateString(): string {
		return format(new Date(), 'yyyy-MM-dd');
	}

	getTodayPlan(): DailyPlan | undefined {
		const row = this.db.select().from(dailyPlans)
			.where(eq(dailyPlans.date, this.getTodayDateString()))
			.get();
		return row as DailyPlan | undefined;
	}

	getPlanWithChunks(planId: number): { chunks: (PlanChunk & { tasks: ChunkTask[] })[] } {
		const chunks = this.db.select().from(planChunks)
			.where(eq(planChunks.planId, planId))
			.orderBy(asc(planChunks.sortOrder))
			.all() as PlanChunk[];

		const chunksWithTasks = chunks.map(chunk => {
			const tasks = this.db.select().from(chunkTasks)
				.where(eq(chunkTasks.chunkId, chunk.id))
				.orderBy(asc(chunkTasks.sortOrder))
				.all() as ChunkTask[];
			return { ...chunk, tasks };
		});

		return { chunks: chunksWithTasks };
	}

	async generatePlan(date: string): Promise<DailyPlan & { chunks: PlanChunk[] }> {
		const treeRow = this.dayTreeService.getTreeRow();
		if (!treeRow) {
			throw new Error('No day tree found.');
		}

		const { id: dayTreeId, tree } = treeRow;

		const allTasks = this.taskService.list();
		const pendingTasks = allTasks.filter(
			t => t.status === 'pending' || t.status === 'active',
		);

		const { system, user } = this.buildPlanPrompt(tree, pendingTasks, date);

		const result = await this.llmProvider.complete({
			messages: [
				{ role: 'system', content: system },
				{ role: 'user', content: user },
			],
			schema: ChunkPlanLlmSchema,
			schemaName: 'chunk_plan',
			temperature: 0.3,
			maxTokens: 2048,
			thinking: false,
		});

		// Build set of valid task IDs from pending tasks
		const validTaskIds = new Set(pendingTasks.map(t => t.id));

		// Insert the daily plan with dayTreeId FK
		const [plan] = this.db.insert(dailyPlans)
			.values({
				date,
				dayTreeId,
				blueprintId: null,
				status: 'active',
				llmReasoning: result.reasoning,
			})
			.returning()
			.all();

		// Insert chunks and their tasks
		const insertedChunks: PlanChunk[] = [];
		for (let i = 0; i < result.chunks.length; i++) {
			const chunk = result.chunks[i];

			// Filter tasks: keep only those with valid taskIds (hallucination defense)
			const validChunkTasks = chunk.tasks.filter(
				t => validTaskIds.has(t.taskId),
			);

			// Insert the plan chunk
			const [insertedChunk] = this.db.insert(planChunks)
				.values({
					planId: plan.id,
					branchName: chunk.branchName,
					label: chunk.label,
					startTime: chunk.startTime,
					endTime: chunk.endTime,
					isTaskSlot: chunk.isTaskSlot,
					sortOrder: i,
					status: 'pending',
				})
				.returning()
				.all();

			// Insert chunk tasks
			for (let j = 0; j < validChunkTasks.length; j++) {
				const task = validChunkTasks[j];
				this.db.insert(chunkTasks)
					.values({
						chunkId: insertedChunk.id,
						taskId: task.taskId,
						label: task.label,
						isLocked: task.isLocked,
						sortOrder: j,
						status: 'pending',
					})
					.run();
			}

			insertedChunks.push(insertedChunk as PlanChunk);
		}

		return { ...(plan as DailyPlan), chunks: insertedChunks };
	}

	async ensureTodayPlan(): Promise<DailyPlan | undefined> {
		const today = this.getTodayDateString();

		const existing = this.getTodayPlan();
		if (existing) return existing;

		const tree = this.dayTreeService.getTree();
		if (!tree) return undefined;

		return this.generatePlan(today);
	}

	private buildPlanPrompt(
		tree: DayTree,
		pendingTasks: { id: number; name: string; isEssential: boolean; postponeCount: number; deadline: string | null }[],
		today: string,
	): { system: string; user: string } {
		const treeText = tree.branches.map(b => {
			const type = b.isTaskSlot ? 'TASK SLOT' : 'FIXED';
			const items = b.items?.map(item => `  ${item.type.toUpperCase()}: ${item.label}`).join('\n') ?? '';
			return `${b.name} (${b.startTime}-${b.endTime}) [${type}]${items ? `\n${items}` : ''}`;
		}).join('\n\n');

		const taskText = pendingTasks.map(t => {
			const flags: string[] = [];
			if (t.isEssential) flags.push('ESSENTIAL');
			if (t.postponeCount > 0) flags.push(`postponed ${t.postponeCount}x`);
			if (t.deadline) flags.push(`deadline: ${t.deadline}`);
			return `  ID:${t.id} "${t.name}" ${flags.join(', ')}`;
		}).join('\n');

		return {
			system: `You are a daily planner. Create a day plan by assigning tasks to the day tree's task-slot branches.

Rules:
- For each branch with isTaskSlot=true, create one or more chunks and assign tasks from the pending pool.
- ESSENTIAL tasks MUST be assigned first. Set isLocked=true for them.
- Tasks with higher postponeCount get priority.
- Tasks with deadlines today or earlier get high priority.
- You may split long task-slot branches into multiple chunks for better pacing.
- Non-task-slot branches become informational chunks with empty tasks arrays.
- Each chunk must have a valid branchName matching a branch in the tree.
- Order chunks by startTime.
- If fewer tasks than capacity, create fewer chunks with available tasks.
- Today's date: ${today}`,
			user: `Day tree:\n${treeText}\n\nPending tasks:\n${taskText}`,
		};
	}
}

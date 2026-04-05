import { eq, asc } from 'drizzle-orm';
import { format } from 'date-fns';
import type { StitchDb } from '../db/index.js';
import { dailyPlans, planChunks } from '../db/schema.js';
import type { BlueprintService } from './blueprint-service.js';
import type { TaskService } from './task-service.js';
import type { LlmProvider } from '../providers/llm.js';
import { DailyPlanLlmSchema } from '../schemas/daily-plan.js';
import type { DailyPlan, PlanChunk } from '../types/daily-plan.js';
import type { FullBlueprint } from '../types/blueprint.js';

export class DailyPlanService {
	constructor(
		private db: StitchDb,
		private blueprintService: BlueprintService,
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

	getPlanChunks(planId: number): PlanChunk[] {
		return this.db.select().from(planChunks)
			.where(eq(planChunks.planId, planId))
			.orderBy(asc(planChunks.sortOrder))
			.all() as PlanChunk[];
	}

	async generatePlan(date: string): Promise<DailyPlan & { chunks: PlanChunk[] }> {
		const blueprint = this.blueprintService.getActiveBlueprint();
		if (!blueprint) {
			throw new Error('No active blueprint found.');
		}

		const allTasks = this.taskService.list();
		const pendingTasks = allTasks.filter(
			t => t.status === 'pending' || t.status === 'active',
		);

		const { system, user } = this.buildPlanPrompt(blueprint, pendingTasks, date);

		const result = await this.llmProvider.complete({
			messages: [
				{ role: 'system', content: system },
				{ role: 'user', content: user },
			],
			schema: DailyPlanLlmSchema,
			schemaName: 'daily_plan',
			temperature: 0.3,
			maxTokens: 2048,
			thinking: false,
		});

		// Build set of valid task IDs from pending tasks
		const validTaskIds = new Set(pendingTasks.map(t => t.id));

		// Filter out chunks with invalid taskIds (hallucination defense)
		const validChunks = result.chunks.filter(
			chunk => chunk.taskId === 0 || validTaskIds.has(chunk.taskId),
		);

		// Insert the daily plan
		const [plan] = this.db.insert(dailyPlans)
			.values({
				date,
				blueprintId: blueprint.id,
				llmReasoning: result.reasoning,
			})
			.returning()
			.all();

		// Insert each valid chunk
		const insertedChunks: PlanChunk[] = [];
		for (let i = 0; i < validChunks.length; i++) {
			const chunk = validChunks[i];
			const [inserted] = this.db.insert(planChunks)
				.values({
					planId: plan.id,
					taskId: chunk.taskId === 0 ? null : chunk.taskId,
					label: chunk.label,
					startTime: chunk.startTime,
					endTime: chunk.endTime,
					isLocked: chunk.isLocked,
					sortOrder: i,
				})
				.returning()
				.all();
			insertedChunks.push(inserted as PlanChunk);
		}

		return { ...(plan as DailyPlan), chunks: insertedChunks };
	}

	async ensureTodayPlan(): Promise<DailyPlan | undefined> {
		const today = this.getTodayDateString();

		const existing = this.getTodayPlan();
		if (existing) return existing;

		const blueprint = this.blueprintService.getActiveBlueprint();
		if (!blueprint) return undefined;

		return this.generatePlan(today);
	}

	private buildPlanPrompt(
		blueprint: FullBlueprint,
		pendingTasks: { id: number; name: string; isEssential: boolean; postponeCount: number; deadline: string | null }[],
		today: string,
	): { system: string; user: string } {
		const blueprintText = blueprint.cycles.map(c => {
			const blocks = c.timeBlocks.map(b => {
				if (b.isSlot) return `  SLOT: ${b.startTime}-${b.endTime} (available for tasks)`;
				return `  FIXED: ${b.startTime}-${b.endTime} ${b.label}`;
			}).join('\n');
			return `${c.name} (${c.startTime}-${c.endTime}):\n${blocks}`;
		}).join('\n\n');

		const taskText = pendingTasks.map(t => {
			const flags: string[] = [];
			if (t.isEssential) flags.push('ESSENTIAL');
			if (t.postponeCount > 0) flags.push(`postponed ${t.postponeCount}x`);
			if (t.deadline) flags.push(`deadline: ${t.deadline}`);
			return `  ID:${t.id} "${t.name}" ${flags.join(', ')}`;
		}).join('\n');

		return {
			system: `You are a daily planner. You assign tasks to available time slots in a day blueprint.

Rules:
- ESSENTIAL tasks MUST be placed first, in the earliest available slots. Set isLocked=true for them.
- Tasks with higher postponeCount get priority (they've been delayed too long).
- Tasks with deadlines today or earlier get high priority.
- Only assign tasks to SLOT blocks (isSlot=true). FIXED blocks remain as-is.
- Each chunk must have a valid taskId matching a provided task, or 0 for fixed blocks.
- If there are more tasks than slots, prioritize by: essential > deadline > postponeCount > order.
- If there are fewer tasks than slots, leave remaining slots with taskId=0 and label="Free time".
- Chunks must be ordered by startTime.
- Today's date: ${today}`,
			user: `Blueprint:\n${blueprintText}\n\nPending tasks:\n${taskText}`,
		};
	}
}

import { z } from 'zod';

export const ChunkTaskAssignmentSchema = z.object({
	taskId: z.number().int().describe('ID of the task from the pending task pool'),
	label: z.string().describe('Display label for this task'),
	isLocked: z.boolean().describe('True if this is an essential/locked task that cannot be moved'),
});

export const PlanChunkSchema = z.object({
	branchName: z.string().describe('Name of the day tree branch this chunk belongs to'),
	label: z.string().describe('Display label for this chunk (e.g., "Work block 1", "Dinner")'),
	startTime: z.string().describe('HH:MM start time'),
	endTime: z.string().describe('HH:MM end time'),
	isTaskSlot: z
		.boolean()
		.describe(
			'True if chunk has assignable tasks. False for informational chunks like dinner or sleep',
		),
	tasks: z
		.array(ChunkTaskAssignmentSchema)
		.describe('Tasks assigned to this chunk. Empty array for non-task-slot chunks'),
});

export const ChunkPlanLlmSchema = z.object({
	chunks: z
		.array(PlanChunkSchema)
		.describe('Ordered list of chunks covering all branches from the day tree'),
	reasoning: z
		.string()
		.describe('Brief explanation of task assignment and chunk splitting decisions'),
});

export type ChunkPlanLlmOutput = z.infer<typeof ChunkPlanLlmSchema>;
export type PlanChunkLlm = z.infer<typeof PlanChunkSchema>;
export type ChunkTaskAssignment = z.infer<typeof ChunkTaskAssignmentSchema>;

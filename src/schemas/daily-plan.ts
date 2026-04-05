import { z } from 'zod';

export const PlanChunkSchema = z.object({
	taskId: z.number().int().describe('ID of the task to assign, or 0 for blueprint fixed blocks'),
	label: z.string().describe('Display label: task name or blueprint block label'),
	startTime: z.string().describe('HH:MM start time within the day'),
	endTime: z.string().describe('HH:MM end time within the day'),
	isLocked: z.boolean().describe('True if this is an essential/locked task that cannot be moved'),
});

export const DailyPlanLlmSchema = z.object({
	chunks: z.array(PlanChunkSchema)
		.describe('Ordered list of time chunks for the day, covering all blueprint slots'),
	reasoning: z.string()
		.describe('Brief explanation of why tasks were assigned to these slots'),
});

export type DailyPlanLlmOutput = z.infer<typeof DailyPlanLlmSchema>;

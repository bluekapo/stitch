import { z } from 'zod';

export const DayTreeItemSchema = z.object({
	label: z.string().describe('Name of the fixed activity or rule'),
	type: z.enum(['fixed', 'rule']).describe('fixed: scheduled activity. rule: permission or constraint'),
});

export const DayTreeCycleSchema = z.object({
	name: z.string().describe('Cycle name'),
	startTime: z.string().describe('Start time in HH:MM format'),
	endTime: z.string().describe('End time in HH:MM format'),
	isTaskSlot: z.boolean().describe('True if cycle contains assignable task time'),
	items: z.array(DayTreeItemSchema).optional().describe('Fixed activities or rules within cycle'),
});

export const DayTreeLlmSchema = z.object({
	cycles: z.array(DayTreeCycleSchema).describe('Ordered list of cycles from wake-up to sleep'),
});

export type DayTree = z.infer<typeof DayTreeLlmSchema>;
export type DayTreeCycle = z.infer<typeof DayTreeCycleSchema>;
export type DayTreeItem = z.infer<typeof DayTreeItemSchema>;

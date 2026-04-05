import { z } from 'zod';

export const DayTreeItemSchema = z.object({
	label: z.string().describe('Name of the fixed activity or rule'),
	type: z.enum(['fixed', 'rule']).describe('fixed: scheduled activity. rule: permission or constraint'),
});

export const DayTreeBranchSchema = z.object({
	name: z.string().describe('Branch name'),
	startTime: z.string().describe('Start time in HH:MM format'),
	endTime: z.string().describe('End time in HH:MM format'),
	isTaskSlot: z.boolean().describe('True if branch contains assignable task time'),
	items: z.array(DayTreeItemSchema).optional().describe('Fixed activities or rules within branch'),
});

export const DayTreeLlmSchema = z.object({
	branches: z.array(DayTreeBranchSchema).describe('Ordered list of branches from wake-up to sleep'),
});

export type DayTree = z.infer<typeof DayTreeLlmSchema>;
export type DayTreeBranch = z.infer<typeof DayTreeBranchSchema>;
export type DayTreeItem = z.infer<typeof DayTreeItemSchema>;

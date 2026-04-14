import { z } from 'zod';

export const TaskParseSchema = z.object({
	name: z
		.string()
		.min(1)
		.max(200)
		.describe('Concise task name extracted from user input, 1-5 words'),
	description: z.string().max(1000).optional().describe('Additional context or details, if any'),
	taskType: z
		.enum(['one-time', 'daily', 'weekly', 'ad-hoc'])
		.describe(
			'one-time: has specific deadline. daily: repeats every day. weekly: repeats on specific day. ad-hoc: no schedule or deadline.',
		),
	deadline: z
		.string()
		.optional()
		.describe(
			'ISO 8601 datetime for deadline, only if user mentioned a specific date/time. null otherwise.',
		),
	recurrenceDay: z
		.number()
		.int()
		.min(0)
		.max(6)
		.optional()
		.describe('For weekly tasks only: 0=Sunday, 1=Monday, ..., 6=Saturday'),
	isEssential: z
		.boolean()
		.describe('True ONLY if user explicitly said must-do, essential, locked, or similar urgency'),
});

export type TaskParseResult = z.infer<typeof TaskParseSchema>;

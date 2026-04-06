import { z } from 'zod';

export const createTaskSchema = z.object({
	name: z.string().min(1).max(200),
	description: z.string().max(1000).optional(),
	isEssential: z.boolean().optional().default(false),
	taskType: z.enum(['one-time', 'daily', 'weekly', 'ad-hoc']).optional().default('ad-hoc'),
	recurrenceDay: z.number().int().min(0).max(6).optional(),
	deadline: z.string().optional(),
	sourceTaskId: z.number().int().positive().optional(),
	// Phase 08.3: optional chunk attachment populated by callers (text-router /
	// voice-handler use the D-16 fallback; DailyPlanService.generatePlan also
	// updates tasks.chunk_id post-insert via direct UPDATE, not via create()).
	chunkId: z.number().int().positive().nullable().optional(),
	branchName: z.string().nullable().optional(),
});

export const updateTaskSchema = z.object({
	name: z.string().min(1).max(200).optional(),
	description: z.string().max(1000).optional(),
	status: z.enum(['pending', 'active', 'completed', 'skipped']).optional(),
});

export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

export interface TaskListItem {
	id: number;
	name: string;
	status: 'pending' | 'active' | 'completed' | 'skipped';
	isEssential: boolean;
	timerStartedAt: string | null;
}

export interface TaskDetail {
	id: number;
	name: string;
	description: string | null;
	status: 'pending' | 'active' | 'completed' | 'skipped';
	isEssential: boolean;
	postponeCount: number;
	timerStartedAt: string | null;
	createdAt: string;
	totalDurationSeconds: number | null;
}

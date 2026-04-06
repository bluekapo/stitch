import type { TaskListItem } from './task.js';

export interface DailyPlan {
	id: number;
	date: string;
	blueprintId: number | null;
	dayTreeId: number | null;
	status: 'active' | 'completed' | 'cancelled';
	llmReasoning: string | null;
	createdAt: string;
}

export interface PlanChunk {
	id: number;
	planId: number;
	taskId: number | null;
	branchName: string;
	label: string;
	startTime: string;
	endTime: string;
	isLocked: boolean;
	isTaskSlot: boolean;
	sortOrder: number;
	status: 'pending' | 'active' | 'completed' | 'skipped';
}

export interface ChunkTask {
	id: number;
	chunkId: number;
	taskId: number | null;
	label: string;
	isLocked: boolean;
	sortOrder: number;
	status: 'pending' | 'active' | 'completed' | 'skipped';
}

export interface DailyPlanView {
	date: string;
	chunks: PlanChunkView[];
}

export interface PlanChunkView {
	label: string;
	startTime: string;
	endTime: string;
	isTaskSlot: boolean;
	status: 'pending' | 'active' | 'completed' | 'skipped';
	tasks: ChunkTaskView[];
}

export interface ChunkTaskView {
	label: string;
	isLocked: boolean;
	status: 'pending' | 'active' | 'completed' | 'skipped';
}

/**
 * Phase 08.3: focused Day Plan view shape consumed by renderCurrentChunkView.
 * Branch + chunk + chunk tasks. Case mapping:
 *   - chunk !== null              -> Screen 1 Case A (render chunk + tasks)
 *   - chunk === null && next !== null -> Screen 1 Case B ("Next chunk starts at HH:MM")
 *   - chunk === null && next === null -> Screen 1 Case C ("No more chunks today")
 *   - undefined view              -> Screen 1 Case D ("No plan for today yet")
 */
export interface CurrentChunkView {
	date: string;
	branchName: string | null;
	chunk: {
		label: string;
		startTime: string; // HH:MM
		endTime: string; // HH:MM
		tasks: Array<{
			label: string;
			status: 'pending' | 'active' | 'completed' | 'skipped';
			isLocked: boolean;
		}>;
	} | null;
	nextChunkStartTime: string | null; // HH:MM, only set when chunk === null AND a later chunk exists today
}

/**
 * Phase 08.3: scoped Tasks view shape consumed by renderCurrentChunkTasksView.
 * Mirrors CurrentChunkView's case mapping but carries TaskListItem[] (the
 * grammY task buttons render the actual list; this shape only feeds the
 * header text + empty-state copy).
 */
export interface CurrentChunkTasksView {
	chunk: {
		label: string;
		startTime: string;
		endTime: string;
		tasks: TaskListItem[];
	} | null;
	nextChunkStartTime: string | null;
}

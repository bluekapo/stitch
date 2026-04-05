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

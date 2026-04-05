export interface DailyPlan {
	id: number;
	date: string;
	blueprintId: number;
	status: 'active' | 'completed' | 'cancelled';
	llmReasoning: string | null;
	createdAt: string;
}

export interface PlanChunk {
	id: number;
	planId: number;
	taskId: number | null;
	label: string;
	startTime: string;
	endTime: string;
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
	isLocked: boolean;
	status: 'pending' | 'active' | 'completed' | 'skipped';
}

// Phase 10 Plan 02 Task 2: PredictionService prompt module.
//
// Decisions implemented:
// - D-01: this module serves the SEPARATE predict LLM call that fires BEFORE plan
// - D-02: output shape is (min, max, confidence) — schema-enforced in prediction.ts
// - D-09: RAW rows only — this file MUST NOT compute averages, medians, or means
// - D-10: per-task history + 7-day global activity
// - D-11: 7-day cap on global activity
// - D-12: global activity includes skipped/postponed (chronic-procrastination signal)
//
// The system prompt is wrapped with the JARVIS soul at call time inside the
// PredictionService (not here) so this module stays a pure prompt template —
// testable without the SOUL.md filesystem dependency.

import { format } from 'date-fns';
import type { DayTree } from '../types/day-tree.js';

export const PREDICTION_SYSTEM_PROMPT = `You estimate how long each pending task will take. You see the user's raw historical data for every task and their global activity from the last 7 days. Your job is to produce a (predicted_min_seconds, predicted_max_seconds, confidence) estimate for each task, with reasoning.

CRITICAL: Do NOT just average prior durations. Averaging is what a calculator does. You are here to reason. For each task:

1. Read the paired (predicted, actual) rows in chronological order.
2. Compare your prior predictions to actual outcomes. State any drift you observe in the reasoning field.
3. Look for patterns: is the task getting faster (learning curve)? Slower (creeping scope)? Bimodal (sometimes 20 min, sometimes 90 min depending on context)? Highly variable?
4. THEN derive a min/max range that captures realistic outcomes, not the mean.
5. The min should be a realistic best case. The max should be a realistic worst case the user should plan against.

Confidence calibration:
- high: you have 5+ historical rows AND the actual durations cluster tightly around your prior predictions.
- medium: you have some history, but it's noisy, sparse (3-5 rows), or you observe drift you haven't fully accounted for.
- low: you have <3 historical rows for this task, OR no history at all (cold start). Reason from the global activity context and the task name.

Cold-start tasks (no history — D-17): produce an estimate anyway. Use the global activity context to find similar-sounding tasks. Mark confidence: 'low'. Do NOT skip the task — every pending task must have a prediction in the response.

Skipped/postponed history rows are signals, not noise. A task that has been postponed 4 times in a week is probably bigger than the user thinks — bias the max upward. A task that gets skipped repeatedly is probably stale, but still produce an estimate.

End the reasoning field of each item with the exact sentence: "Based on N rows and observed drift, classifying as <confidence>." where <confidence> is one of low, medium, high.

Output a JSON object with a "predictions" array, one entry per pending task. Use the exact taskId from the input — never invent a taskId.

Example 1 (history present, observable drift):
Input task: "Write report" with 4 paired rows showing systematic underestimation.
Output:
  reasoning: "Four prior runs: predicted 15-25 max each time, actuals were 28, 32, 30, 48. I underestimate by ~25% and one outlier at 48 when scope crept. Adjust upward and widen range. Based on 4 rows and observed drift, classifying as medium."
  taskId: 42
  predicted_min_seconds: 1800
  predicted_max_seconds: 3000
  confidence: "medium"

Example 2 (cold start, similar tasks in global activity):
Input task: "Reply to PM email" with 0 history.
Output:
  reasoning: "No history for this task. Global activity shows 'Email triage' completing in 15-25 min and other reply-style tasks in 5-10 min. Single email reply is the smaller end. Based on 0 rows and no drift signal, classifying as low."
  taskId: 77
  predicted_min_seconds: 300
  predicted_max_seconds: 900
  confidence: "low"`;

// ----------------------------------------------------------------------------

export interface TaskDurationRow {
	id: number;
	taskId: number;
	durationSeconds: number | null;
	outcome: 'completed' | 'skipped' | 'postponed';
	predictedMinSeconds: number | null;
	predictedMaxSeconds: number | null;
	predictedConfidence: 'low' | 'medium' | 'high' | null;
	startedAt: string;
}

export interface GlobalActivityRow extends TaskDurationRow {
	taskName: string;
}

export interface BuildPredictionUserPromptArgs {
	pendingTasks: Array<{ id: number; name: string; sourceTaskId: number | null }>;
	perTaskHistory: Map<number, TaskDurationRow[]>;
	globalActivity: GlobalActivityRow[];
	tree: DayTree | null;
	now: Date;
}

function formatDurationMin(seconds: number | null): string {
	if (seconds == null) return '(no actual)';
	return `${Math.round(seconds / 60)} min`;
}

function formatPrediction(min: number | null, max: number | null, conf: string | null): string {
	if (min == null || max == null) return '(no prior prediction)';
	return `predicted ${Math.round(min / 60)}-${Math.round(max / 60)} min (${conf ?? 'unknown'})`;
}

function formatTaskHistoryBlock(
	task: { id: number; name: string },
	rows: TaskDurationRow[],
): string {
	if (rows.length === 0) {
		return `Task "${task.name}" (id=${task.id}):\n  (no history — cold start)`;
	}
	const lines = [`Task "${task.name}" (id=${task.id}):`];
	// Raw rows, chronological. Per D-09, this loop MUST NOT compute averages,
	// medians, or means — the LLM does the reasoning, not the formatter.
	for (const row of rows) {
		const ts = row.startedAt;
		const outcome = row.outcome.toUpperCase();
		const actual = formatDurationMin(row.durationSeconds);
		const pred = formatPrediction(
			row.predictedMinSeconds,
			row.predictedMaxSeconds,
			row.predictedConfidence,
		);
		lines.push(`  ${ts}  ${outcome}  actual=${actual}  ${pred}`);
	}
	return lines.join('\n');
}

function formatGlobalActivityBlock(rows: GlobalActivityRow[]): string {
	if (rows.length === 0) {
		return 'Global activity (last 7 days): (no activity recorded)';
	}
	const lines = ['Global activity (last 7 days, all tasks, chronological):'];
	for (const row of rows) {
		const ts = row.startedAt;
		const outcome = row.outcome.toUpperCase();
		const actual = formatDurationMin(row.durationSeconds);
		lines.push(`  ${ts}  ${outcome}  "${row.taskName}"  actual=${actual}`);
	}
	return lines.join('\n');
}

export function buildPredictionUserPrompt(args: BuildPredictionUserPromptArgs): string {
	const { pendingTasks, perTaskHistory, globalActivity, now } = args;

	const header = `Today is ${format(now, 'yyyy-MM-dd EEEE')}. You have ${pendingTasks.length} pending task(s) to estimate.`;

	const perTaskBlocks = pendingTasks
		.map((task) => {
			const rows = perTaskHistory.get(task.id) ?? [];
			return formatTaskHistoryBlock(task, rows);
		})
		.join('\n\n');

	const globalBlock = formatGlobalActivityBlock(globalActivity);

	const footer =
		'Produce one prediction per pending task. Use exact taskIds. End each reasoning with the classification sentence.';

	return [header, '', perTaskBlocks, '', globalBlock, '', footer].join('\n');
}

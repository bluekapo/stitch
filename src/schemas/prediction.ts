import { z } from 'zod';

/**
 * Phase 10 Plan 02 Task 1 — PredictionService LLM response schema.
 *
 * Per D-02: output shape is (predicted_min_seconds, predicted_max_seconds, confidence)
 * with reasoning as a REQUIRED FIRST field. Reasoning-first forces Qwen3-8B to emit
 * chain-of-thought before committing to numeric/enum fields — the anti-averaging
 * forcing function (10-RESEARCH.md §"Confidence Calibration").
 *
 * Field order in this object literal == field order in the emitted JSON Schema ==
 * field order Qwen3-8B emits at inference time. Do NOT reorder.
 *
 * RESEARCH Pitfall 8 mitigation: belt-and-suspenders. The provider validates via
 * response_format (JSON Schema produced by z.toJSONSchema) AND Zod safeParse. The
 * smoke tests in test/schemas/prediction.test.ts assert the draft-07 shape.
 */

export const PredictionItemSchema = z.object({
	reasoning: z
		.string()
		.describe(
			'Walk the paired (predicted, actual) rows for this task. Compare your prior predictions to actual outcomes. State any drift you observe (e.g., "I predicted 25 max and it took 32, I underestimate by ~25%"). Then derive the new prediction. End with: "Based on N rows and observed drift, classifying as <confidence>." If there is no history, say so explicitly and reason from global activity.',
		),
	taskId: z
		.number()
		.int()
		.describe(
			'id from the pending task list — never invent a taskId. Must match one of the ids in the input.',
		),
	predicted_min_seconds: z
		.number()
		.int()
		.min(0)
		.max(86400)
		.describe(
			'Realistic best-case duration in seconds. Should be honest, not optimistic. Max 86400 (24 hours).',
		),
	predicted_max_seconds: z
		.number()
		.int()
		.min(0)
		.max(86400)
		.describe(
			'Realistic worst-case duration in seconds. Should cover scope creep but not catastrophic outliers. Max 86400 (24 hours).',
		),
	confidence: z
		.enum(['low', 'medium', 'high'])
		.describe(
			'low: <3 historical rows for this task OR cold start (no history). medium: 3-5 noisy rows OR observable drift not fully accounted for. high: 5+ rows AND actuals cluster tightly around prior predictions.',
		),
});

export const PredictionResponseSchema = z.object({
	predictions: z
		.array(PredictionItemSchema)
		.describe(
			'One prediction per pending task. EVERY task in the input must have a prediction — do not skip any task. Use the exact taskId from the input list.',
		),
});

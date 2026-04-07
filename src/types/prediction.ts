import type { z } from 'zod';
import type { PredictionItemSchema, PredictionResponseSchema } from '../schemas/prediction.js';

/**
 * Phase 10 Plan 02 Task 1 — inferred types from PredictionResponseSchema.
 *
 * Single source of truth: src/schemas/prediction.ts. All callers (PredictionService,
 * DailyPlanService consumers, display layer) import these types — never declare
 * the shape inline.
 */

export type PredictionItem = z.infer<typeof PredictionItemSchema>;
export type PredictionResponse = z.infer<typeof PredictionResponseSchema>;

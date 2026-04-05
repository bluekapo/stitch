import { z } from 'zod';

/**
 * Example schema for testing structured LLM output.
 * Used in Phase 1 to validate the structured JSON pipeline works end-to-end.
 * Real schemas for task parsing, day planning, etc. will be added in later phases.
 */
export const TaskAnalysisSchema = z.object({
	taskName: z.string(),
	estimatedMinutes: z.number(),
	category: z.enum(['work', 'personal', 'health', 'learning']),
	subtasks: z.array(z.string()),
});

export type TaskAnalysis = z.infer<typeof TaskAnalysisSchema>;

/**
 * Convert a Zod schema to JSON Schema for llama-server response_format.
 * Uses Zod 4 native z.toJSONSchema() -- no external library needed.
 * Target draft-07 for broad compatibility.
 */
export function toResponseFormat(schema: z.ZodType, name: string) {
	const jsonSchema = z.toJSONSchema(schema, { target: 'draft-07' });
	return {
		type: 'json_schema' as const,
		json_schema: {
			name,
			strict: true,
			schema: jsonSchema,
		},
	};
}

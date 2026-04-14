import { z } from 'zod';

/**
 * Phase 08.4 classifier response schema.
 *
 * Discriminated union keyed on `intent`. Each branch carries ONLY the fields
 * relevant to that intent so the LLM cannot (schema-reject) put `modification`
 * on a `task_query` response.
 *
 * Decision references:
 * - D-01: 8 intents collapsed into 5 union branches
 * - D-13: discriminated union keyed on "intent"
 * - D-22: confidence field; 0.7 threshold lives in router, not schema
 * - D-23: JARVIS-voice clarification composed by LLM when confidence < 0.7
 * - D-26: suggested_chunk_id + suggested_branch_name inline on task_create
 * - D-27: current chunk is pre-resolved in the prompt; LLM may default to it
 *
 * RESEARCH Pitfall 1: Zod 4 discriminated union -> llama.cpp grammar engine
 * has no prior production use in this codebase. Mitigation: belt-and-suspenders
 * (response_format + Zod safeParse via provider) AND a JSON Schema smoke test
 * in test/schemas/intent.test.ts that asserts the shape llama.cpp expects
 * (top-level oneOf, per-branch additionalProperties: false, required array).
 */

const TaskCreateBranch = z.object({
	intent: z.literal('task_create'),
	confidence: z
		.number()
		.min(0)
		.max(1)
		.describe('Confidence 0-1; below 0.7 triggers clarification reply'),
	suggested_chunk_id: z
		.number()
		.int()
		.nullable()
		.describe(
			'chunk_id from current plan, null if no current chunk active or task targets a different time',
		),
	suggested_branch_name: z
		.string()
		.nullable()
		.describe('branch name matching the chunk, null if none'),
	is_essential: z
		.boolean()
		.describe('True ONLY if user explicitly says must-do, essential, locked, or critical'),
	clarification: z
		.string()
		.optional()
		.describe('JARVIS-voice question, only set when confidence < 0.7'),
});

const TaskModifyBranch = z.object({
	intent: z.literal('task_modify'),
	confidence: z.number().min(0).max(1),
	task_id: z.number().int().describe('id from the pending task list, never invented'),
	action: z.enum(['done', 'postpone']).describe('done = mark complete, postpone = delay'),
	clarification: z.string().optional(),
});

const TreeEditBranch = z.object({
	intent: z.literal('tree_edit'),
	confidence: z.number().min(0).max(1),
	modification: z
		.string()
		.describe('CLEANED phrase, NOT raw user text. e.g. "move dinner to 20:00"'),
	clarification: z.string().optional(),
});

const PlanRegenerateBranch = z.object({
	intent: z.literal('plan_regenerate'),
	confidence: z.number().min(0).max(1),
	target_date: z
		.enum(['today', 'tomorrow'])
		.describe('today is default; tomorrow only if user explicitly says tomorrow'),
	clarification: z.string().optional(),
});

const QueryViewBranch = z.object({
	intent: z.enum(['task_query', 'tree_query', 'plan_view', 'unknown']),
	confidence: z.number().min(0).max(1),
	clarification: z.string().optional().describe('Required for unknown intent or low confidence'),
});

export const ClassifierResponseSchema = z.discriminatedUnion('intent', [
	TaskCreateBranch,
	TaskModifyBranch,
	TreeEditBranch,
	PlanRegenerateBranch,
	QueryViewBranch,
]);

export type ClassifiedIntent = z.infer<typeof ClassifierResponseSchema>;

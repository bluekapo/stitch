import { z } from 'zod';

/**
 * Phase 08.4 classifier response schema -- extended by Phase 13 into a
 * two-level discriminated union.
 *
 * Decision references:
 * - D-01 (08.4): 8 intents -> 5 branches; Phase 13 adds 3 more (tree_setup,
 *   tree_confirm, compound) -> 8 top-level branches.
 * - D-13 (08.4): discriminated union keyed on "intent".
 * - D-22 (08.4): confidence field; 0.7 threshold lives in router, not schema.
 * - D-18 (12): compound-intent deferred -> Phase 13 lifts the ban (D-20).
 * - D-20 (13): top-level `compound` branch with `steps[]`.
 * - D-22 (13): sequential continue-on-error -- enforcement in router, not schema.
 * - D-23 (13): flat-compound enforcement. Structural, not refinement:
 *   CompoundBranch.steps uses StepIntentSchema which does NOT contain
 *   compound. Nested compound is impossible by construction.
 *
 * RESEARCH Pitfall 1 (08.4): Zod 4 -> llama.cpp grammar engine. Belt-and-
 * suspenders (response_format + Zod safeParse via provider) + JSON Schema
 * smoke tests in test/schemas/intent.test.ts. Phase 13 extends the smoke
 * tests to cover all 8 branches + nested-compound rejection.
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
	// D-14 (Phase 12): five-value action enum. Additive extension -- grammar regression
	// risk mitigated by the Pitfall 1 smoke tests in test/schemas/intent.test.ts.
	action: z
		.enum(['done', 'postpone', 'delete', 'start_timer', 'stop_timer'])
		.describe(
			'done = mark complete, postpone = delay, delete = remove task, start_timer = start timer, stop_timer = stop timer and record duration',
		),
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
	// D-16 (Phase 12): task_query-specific optional scope narrowing. Omit for all
	// pending tasks; set to 'current_chunk' to limit the view to the active chunk.
	scope: z
		.enum(['all', 'current_chunk'])
		.optional()
		.describe(
			'task_query only -- omit for all pending; "current_chunk" narrows to the active chunk',
		),
	// D-16 (Phase 12): plan_view-specific optional future-day target. Mirrors the
	// enum on plan_regenerate so the router can reuse the same knob.
	target_date: z
		.enum(['today', 'tomorrow'])
		.optional()
		.describe('plan_view only -- omit for today, "tomorrow" for the next day'),
});

// Phase 13 (D-09): tree_setup -- user wants to build/rebuild their day tree
// via conversation. No payload fields; TreeSetupService handles the
// conversation separately.
const TreeSetupBranch = z.object({
	intent: z.literal('tree_setup'),
	confidence: z.number().min(0).max(1),
	clarification: z.string().optional(),
});

// Phase 13 (D-10): tree_confirm -- user is confirming a pending
// propose_tree from the latest assistant tree-setup turn. Disambiguation
// hinges on recent_turns (supplied by the classifier user prompt).
const TreeConfirmBranch = z.object({
	intent: z.literal('tree_confirm'),
	confidence: z.number().min(0).max(1),
	clarification: z.string().optional(),
});

/**
 * Phase 13 (D-20, D-23): step-level union for compound branches.
 * Excludes the `compound` branch itself -- flat-only enforced structurally.
 * No superRefine, no z.lazy -- the nested-compound case is impossible by
 * type construction (RESEARCH S3).
 */
export const StepIntentSchema = z.discriminatedUnion('intent', [
	TaskCreateBranch,
	TaskModifyBranch,
	TreeEditBranch,
	PlanRegenerateBranch,
	QueryViewBranch,
	TreeSetupBranch,
	TreeConfirmBranch,
]);
export type StepIntent = z.infer<typeof StepIntentSchema>;

// Phase 13 (D-20, D-22): top-level compound branch.
const CompoundBranch = z.object({
	intent: z.literal('compound'),
	confidence: z.number().min(0).max(1),
	steps: z
		.array(StepIntentSchema)
		.min(2)
		.describe(
			'At least 2 steps. Flat only -- steps cannot themselves be compound (enforced structurally).',
		),
	clarification: z.string().optional(),
});

export const ClassifierResponseSchema = z.discriminatedUnion('intent', [
	TaskCreateBranch,
	TaskModifyBranch,
	TreeEditBranch,
	PlanRegenerateBranch,
	QueryViewBranch,
	TreeSetupBranch,
	TreeConfirmBranch,
	CompoundBranch,
]);

export type ClassifiedIntent = z.infer<typeof ClassifierResponseSchema>;

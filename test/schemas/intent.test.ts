import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ClassifierResponseSchema, StepIntentSchema } from '../../src/schemas/intent.js';

describe('ClassifierResponseSchema parses', () => {
	it('parses task_create branch', () => {
		const result = ClassifierResponseSchema.safeParse({
			intent: 'task_create',
			confidence: 0.95,
			suggested_chunk_id: 42,
			suggested_branch_name: 'Day branch',
			is_essential: false,
		});
		expect(result.success).toBe(true);
	});

	it('parses task_modify branch with action=done', () => {
		const result = ClassifierResponseSchema.safeParse({
			intent: 'task_modify',
			confidence: 0.9,
			task_id: 7,
			action: 'done',
		});
		expect(result.success).toBe(true);
	});

	it('parses task_modify branch with action=postpone', () => {
		const result = ClassifierResponseSchema.safeParse({
			intent: 'task_modify',
			confidence: 0.88,
			task_id: 12,
			action: 'postpone',
		});
		expect(result.success).toBe(true);
	});

	it('parses tree_edit branch with cleaned modification phrase', () => {
		const result = ClassifierResponseSchema.safeParse({
			intent: 'tree_edit',
			confidence: 0.95,
			modification: 'move dinner to 20:00',
		});
		expect(result.success).toBe(true);
		if (result.success && result.data.intent === 'tree_edit') {
			expect(result.data.modification).toBe('move dinner to 20:00');
		}
	});

	it('parses plan_regenerate branch with target_date=today', () => {
		const result = ClassifierResponseSchema.safeParse({
			intent: 'plan_regenerate',
			confidence: 0.95,
			target_date: 'today',
		});
		expect(result.success).toBe(true);
	});

	it('parses plan_regenerate branch with target_date=tomorrow', () => {
		const result = ClassifierResponseSchema.safeParse({
			intent: 'plan_regenerate',
			confidence: 0.92,
			target_date: 'tomorrow',
		});
		expect(result.success).toBe(true);
	});

	it('parses task_query intent', () => {
		const result = ClassifierResponseSchema.safeParse({
			intent: 'task_query',
			confidence: 0.95,
		});
		expect(result.success).toBe(true);
	});

	it('parses tree_query intent', () => {
		const result = ClassifierResponseSchema.safeParse({
			intent: 'tree_query',
			confidence: 0.95,
		});
		expect(result.success).toBe(true);
	});

	it('parses plan_view intent', () => {
		const result = ClassifierResponseSchema.safeParse({
			intent: 'plan_view',
			confidence: 0.95,
		});
		expect(result.success).toBe(true);
	});

	it('parses unknown intent with clarification', () => {
		const result = ClassifierResponseSchema.safeParse({
			intent: 'unknown',
			confidence: 0.3,
			clarification: 'Apologies, Sir. Could you rephrase that?',
		});
		expect(result.success).toBe(true);
	});

	it('rejects invalid intent literal', () => {
		const result = ClassifierResponseSchema.safeParse({
			intent: 'bogus_intent',
			confidence: 0.9,
		});
		expect(result.success).toBe(false);
	});

	it('rejects task_modify missing task_id', () => {
		const result = ClassifierResponseSchema.safeParse({
			intent: 'task_modify',
			confidence: 0.9,
			action: 'done',
		});
		expect(result.success).toBe(false);
	});

	it('rejects tree_edit missing modification', () => {
		const result = ClassifierResponseSchema.safeParse({
			intent: 'tree_edit',
			confidence: 0.95,
		});
		expect(result.success).toBe(false);
	});

	it('rejects confidence > 1', () => {
		const result = ClassifierResponseSchema.safeParse({
			intent: 'task_query',
			confidence: 1.5,
		});
		expect(result.success).toBe(false);
	});

	it('rejects confidence < 0', () => {
		const result = ClassifierResponseSchema.safeParse({
			intent: 'task_query',
			confidence: -0.1,
		});
		expect(result.success).toBe(false);
	});
});

describe('ClassifierResponseSchema -> JSON Schema (Pitfall 1 smoke)', () => {
	it('produces a top-level oneOf with at least 8 branches', () => {
		const jsonSchema = z.toJSONSchema(ClassifierResponseSchema, { target: 'draft-07' });
		expect(jsonSchema).toHaveProperty('oneOf');
		expect((jsonSchema as { oneOf: unknown[] }).oneOf.length).toBeGreaterThanOrEqual(8);
	});

	it('StepIntentSchema produces oneOf with exactly 7 branches (no compound)', () => {
		const jsonSchema = z.toJSONSchema(StepIntentSchema, { target: 'draft-07' });
		expect(jsonSchema).toHaveProperty('oneOf');
		expect((jsonSchema as { oneOf: unknown[] }).oneOf.length).toBe(7);
	});

	it('every top-level branch (8) has additionalProperties: false', () => {
		const jsonSchema = z.toJSONSchema(ClassifierResponseSchema, {
			target: 'draft-07',
		}) as { oneOf: Array<{ additionalProperties: boolean }> };
		expect(jsonSchema.oneOf.length).toBe(8);
		for (const branch of jsonSchema.oneOf) {
			expect(branch.additionalProperties).toBe(false);
		}
	});

	it('every top-level branch (8) has required array containing intent and confidence', () => {
		const jsonSchema = z.toJSONSchema(ClassifierResponseSchema, {
			target: 'draft-07',
		}) as { oneOf: Array<{ required: string[] }> };
		expect(jsonSchema.oneOf.length).toBe(8);
		for (const branch of jsonSchema.oneOf) {
			expect(branch.required).toContain('intent');
			expect(branch.required).toContain('confidence');
		}
	});

	it('every step-level branch (7) has additionalProperties: false', () => {
		const jsonSchema = z.toJSONSchema(StepIntentSchema, {
			target: 'draft-07',
		}) as { oneOf: Array<{ additionalProperties: boolean }> };
		expect(jsonSchema.oneOf.length).toBe(7);
		for (const branch of jsonSchema.oneOf) {
			expect(branch.additionalProperties).toBe(false);
		}
	});

	it('every step-level branch (7) has required array containing intent and confidence', () => {
		const jsonSchema = z.toJSONSchema(StepIntentSchema, {
			target: 'draft-07',
		}) as { oneOf: Array<{ required: string[] }> };
		expect(jsonSchema.oneOf.length).toBe(7);
		for (const branch of jsonSchema.oneOf) {
			expect(branch.required).toContain('intent');
			expect(branch.required).toContain('confidence');
		}
	});
});

// Phase 12 Plan 01 Task 3 — Nyquist RED fixtures for D-14 / D-16.
// These tests INTENTIONALLY fail today; 12-03 extends the schema to turn
// them green. Keep the existing Pitfall 1 fixtures above unchanged.

describe('D-14: task_modify action enum (Phase 12)', () => {
	it.each(['delete', 'start_timer', 'stop_timer'])('accepts action=%s', (action) => {
		const parsed = ClassifierResponseSchema.safeParse({
			intent: 'task_modify',
			confidence: 0.9,
			task_id: 42,
			action,
		});
		expect(parsed.success).toBe(true);
	});

	it('rejects unknown action', () => {
		const parsed = ClassifierResponseSchema.safeParse({
			intent: 'task_modify',
			confidence: 0.9,
			task_id: 42,
			action: 'nonsense',
		});
		expect(parsed.success).toBe(false);
	});
});

describe('D-16: QueryViewBranch scope + target_date (Phase 12)', () => {
	it("accepts task_query with scope: 'current_chunk'", () => {
		const parsed = ClassifierResponseSchema.safeParse({
			intent: 'task_query',
			confidence: 0.9,
			scope: 'current_chunk',
		});
		expect(parsed.success).toBe(true);
	});

	it('accepts task_query without scope (optional field)', () => {
		const parsed = ClassifierResponseSchema.safeParse({
			intent: 'task_query',
			confidence: 0.9,
		});
		expect(parsed.success).toBe(true);
	});

	it("accepts plan_view with target_date: 'tomorrow'", () => {
		const parsed = ClassifierResponseSchema.safeParse({
			intent: 'plan_view',
			confidence: 0.9,
			target_date: 'tomorrow',
		});
		expect(parsed.success).toBe(true);
	});

	it('accepts plan_view without target_date (optional field)', () => {
		const parsed = ClassifierResponseSchema.safeParse({
			intent: 'plan_view',
			confidence: 0.9,
		});
		expect(parsed.success).toBe(true);
	});

	it("rejects plan_view with target_date: 'yesterday' (enum rejection)", () => {
		const parsed = ClassifierResponseSchema.safeParse({
			intent: 'plan_view',
			confidence: 0.9,
			target_date: 'yesterday',
		});
		expect(parsed.success).toBe(false);
	});
});

// Phase 13 Plan 01 — Nyquist RED fixtures for tree_setup, tree_confirm, compound.
// These tests INTENTIONALLY fail today because StepIntentSchema, TreeSetupBranch,
// TreeConfirmBranch, and CompoundBranch don't exist yet. Waves 2-4 add them.

describe('Phase 13 classifier branches', () => {
	it('accepts tree_setup branch', () => {
		const parsed = ClassifierResponseSchema.safeParse({
			intent: 'tree_setup',
			confidence: 0.85,
			clarification: undefined,
		});
		expect(parsed.success).toBe(true);
	});

	it('accepts tree_confirm branch', () => {
		const parsed = ClassifierResponseSchema.safeParse({
			intent: 'tree_confirm',
			confidence: 0.95,
		});
		expect(parsed.success).toBe(true);
	});

	it('accepts compound branch with 2 steps', () => {
		const parsed = ClassifierResponseSchema.safeParse({
			intent: 'compound',
			confidence: 0.9,
			steps: [
				{
					intent: 'task_create',
					confidence: 0.95,
					suggested_chunk_id: null,
					suggested_branch_name: null,
					is_essential: false,
				},
				{
					intent: 'task_modify',
					confidence: 0.9,
					task_id: 7,
					action: 'done',
				},
			],
		});
		expect(parsed.success).toBe(true);
	});

	it('accepts compound branch where a step is tree_setup', () => {
		const parsed = ClassifierResponseSchema.safeParse({
			intent: 'compound',
			confidence: 0.88,
			steps: [
				{
					intent: 'tree_setup',
					confidence: 0.85,
				},
				{
					intent: 'task_create',
					confidence: 0.95,
					suggested_chunk_id: null,
					suggested_branch_name: null,
					is_essential: false,
				},
			],
		});
		expect(parsed.success).toBe(true);
	});

	it('accepts compound with task_query step', () => {
		const parsed = ClassifierResponseSchema.safeParse({
			intent: 'compound',
			confidence: 0.85,
			steps: [
				{
					intent: 'task_create',
					confidence: 0.9,
					suggested_chunk_id: null,
					suggested_branch_name: null,
					is_essential: false,
				},
				{
					intent: 'task_query',
					confidence: 0.9,
				},
			],
		});
		expect(parsed.success).toBe(true);
	});

	it('rejects nested compound in steps[]', () => {
		const parsed = ClassifierResponseSchema.safeParse({
			intent: 'compound',
			confidence: 0.9,
			steps: [
				{
					intent: 'task_create',
					confidence: 0.95,
					suggested_chunk_id: null,
					suggested_branch_name: null,
					is_essential: false,
				},
				{
					intent: 'compound',
					confidence: 0.9,
					steps: [
						{
							intent: 'task_modify',
							confidence: 0.9,
							task_id: 1,
							action: 'done',
						},
						{
							intent: 'task_modify',
							confidence: 0.9,
							task_id: 2,
							action: 'postpone',
						},
					],
				},
			],
		});
		expect(parsed.success).toBe(false);
	});

	it('rejects compound with only 1 step (min 2)', () => {
		const parsed = ClassifierResponseSchema.safeParse({
			intent: 'compound',
			confidence: 0.9,
			steps: [
				{
					intent: 'task_create',
					confidence: 0.95,
					suggested_chunk_id: null,
					suggested_branch_name: null,
					is_essential: false,
				},
			],
		});
		expect(parsed.success).toBe(false);
	});
});

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ClassifierResponseSchema } from '../../src/schemas/intent.js';

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
	it('produces a top-level oneOf with at least 5 branches', () => {
		const jsonSchema = z.toJSONSchema(ClassifierResponseSchema, { target: 'draft-07' });
		expect(jsonSchema).toHaveProperty('oneOf');
		expect((jsonSchema as { oneOf: unknown[] }).oneOf.length).toBeGreaterThanOrEqual(5);
	});

	it('every branch has additionalProperties: false', () => {
		const jsonSchema = z.toJSONSchema(ClassifierResponseSchema, {
			target: 'draft-07',
		}) as { oneOf: Array<{ additionalProperties: boolean }> };
		for (const branch of jsonSchema.oneOf) {
			expect(branch.additionalProperties).toBe(false);
		}
	});

	it('every branch has required array containing intent and confidence', () => {
		const jsonSchema = z.toJSONSchema(ClassifierResponseSchema, {
			target: 'draft-07',
		}) as { oneOf: Array<{ required: string[] }> };
		for (const branch of jsonSchema.oneOf) {
			expect(branch.required).toContain('intent');
			expect(branch.required).toContain('confidence');
		}
	});
});

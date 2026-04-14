import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BufferEndDispositionSchema, CheckInResponseSchema } from '../../src/schemas/check-in.js';

describe('CheckInResponseSchema parses', () => {
	it('should_speak=true with message and 30min cadence', () => {
		const result = CheckInResponseSchema.safeParse({
			should_speak: true,
			message: 'Morning duties begin in 12 minutes, Sir.',
			next_check_minutes: 30,
		});
		expect(result.success).toBe(true);
	});

	it('should_speak=false with null message', () => {
		const result = CheckInResponseSchema.safeParse({
			should_speak: false,
			message: null,
			next_check_minutes: 45,
		});
		expect(result.success).toBe(true);
	});

	it('with optional reasoning field', () => {
		const result = CheckInResponseSchema.safeParse({
			should_speak: true,
			message: 'Three postponements. The pattern is noted.',
			next_check_minutes: 20,
			reasoning: 'Slack signal: laundry postponed 3x',
		});
		expect(result.success).toBe(true);
	});

	it('rejects next_check_minutes=0', () => {
		const result = CheckInResponseSchema.safeParse({
			should_speak: false,
			message: null,
			next_check_minutes: 0,
		});
		expect(result.success).toBe(false);
	});

	it('rejects next_check_minutes=400', () => {
		const result = CheckInResponseSchema.safeParse({
			should_speak: false,
			message: null,
			next_check_minutes: 400,
		});
		expect(result.success).toBe(false);
	});
});

describe('BufferEndDispositionSchema parses', () => {
	it('all 4 action enum values in one batch', () => {
		const result = BufferEndDispositionSchema.safeParse({
			decisions: [
				{ taskId: 1, action: 'continue' },
				{ taskId: 2, action: 'postpone' },
				{ taskId: 3, action: 'skip' },
				{ taskId: 4, action: 'move_to_next_chunk' },
			],
		});
		expect(result.success).toBe(true);
	});

	it('empty decisions array', () => {
		const result = BufferEndDispositionSchema.safeParse({ decisions: [] });
		expect(result.success).toBe(true);
	});

	it('rejects unknown action', () => {
		const result = BufferEndDispositionSchema.safeParse({
			decisions: [{ taskId: 1, action: 'foo' }],
		});
		expect(result.success).toBe(false);
	});
});

describe('CheckInResponseSchema -> JSON Schema (Pitfall 8 smoke)', () => {
	it('produces a draft-07 object schema', () => {
		const jsonSchema = z.toJSONSchema(CheckInResponseSchema, {
			target: 'draft-07',
		}) as {
			type: string;
			required: string[];
			properties: Record<string, unknown>;
		};
		expect(jsonSchema.type).toBe('object');
		expect(jsonSchema.required).toContain('should_speak');
		expect(jsonSchema.required).toContain('message');
		expect(jsonSchema.required).toContain('next_check_minutes');
	});
});

describe('BufferEndDispositionSchema -> JSON Schema (Pitfall 8 smoke)', () => {
	it('produces a draft-07 object schema with decisions array', () => {
		const jsonSchema = z.toJSONSchema(BufferEndDispositionSchema, {
			target: 'draft-07',
		}) as {
			type: string;
			required: string[];
			properties: { decisions: { type: string } };
		};
		expect(jsonSchema.type).toBe('object');
		expect(jsonSchema.required).toContain('decisions');
		expect(jsonSchema.properties.decisions.type).toBe('array');
	});
});

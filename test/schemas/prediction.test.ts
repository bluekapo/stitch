import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PredictionItemSchema, PredictionResponseSchema } from '../../src/schemas/prediction.js';

describe('PredictionResponseSchema', () => {
	it('parses valid response with all three confidence values', () => {
		const valid = {
			predictions: [
				{
					reasoning: 'Three rows, tight cluster. Based on 3 rows and observed drift, classifying as high.',
					taskId: 1,
					predicted_min_seconds: 600,
					predicted_max_seconds: 900,
					confidence: 'high' as const,
				},
				{
					reasoning: 'Noisy. Based on 4 rows and observed drift, classifying as medium.',
					taskId: 2,
					predicted_min_seconds: 1200,
					predicted_max_seconds: 2400,
					confidence: 'medium' as const,
				},
				{
					reasoning: 'Cold start. Based on 0 rows and no drift signal, classifying as low.',
					taskId: 3,
					predicted_min_seconds: 300,
					predicted_max_seconds: 1800,
					confidence: 'low' as const,
				},
			],
		};
		const result = PredictionResponseSchema.safeParse(valid);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.predictions).toHaveLength(3);
			expect(result.data.predictions[0].confidence).toBe('high');
			expect(result.data.predictions[1].confidence).toBe('medium');
			expect(result.data.predictions[2].confidence).toBe('low');
		}
	});

	it('rejects invalid confidence value', () => {
		const invalid = {
			predictions: [
				{
					reasoning: 'x',
					taskId: 1,
					predicted_min_seconds: 0,
					predicted_max_seconds: 60,
					confidence: 'maybe',
				},
			],
		};
		const result = PredictionResponseSchema.safeParse(invalid);
		expect(result.success).toBe(false);
	});

	it('rejects item missing reasoning field', () => {
		const invalid = {
			predictions: [
				{
					taskId: 1,
					predicted_min_seconds: 0,
					predicted_max_seconds: 60,
					confidence: 'low',
				},
			],
		};
		const result = PredictionResponseSchema.safeParse(invalid);
		expect(result.success).toBe(false);
	});

	it('produces draft-07 object schema with required fields (Pitfall 8 smoke)', () => {
		const jsonSchema = z.toJSONSchema(PredictionResponseSchema, {
			target: 'draft-07',
		}) as {
			type: string;
			required: string[];
			properties: { predictions: { type: string; items: { required: string[] } } };
		};
		expect(jsonSchema.type).toBe('object');
		expect(jsonSchema.required).toContain('predictions');
		expect(jsonSchema.properties.predictions.type).toBe('array');

		// Each item must require all fields including reasoning-first ordering.
		const itemRequired = jsonSchema.properties.predictions.items.required;
		expect(itemRequired).toContain('reasoning');
		expect(itemRequired).toContain('taskId');
		expect(itemRequired).toContain('predicted_min_seconds');
		expect(itemRequired).toContain('predicted_max_seconds');
		expect(itemRequired).toContain('confidence');

		// Serialised shape must contain confidence enum values
		const serialised = JSON.stringify(jsonSchema);
		expect(serialised).toContain('"low"');
		expect(serialised).toContain('"medium"');
		expect(serialised).toContain('"high"');
	});
});

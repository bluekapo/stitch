import { describe, expect, it } from 'vitest';
import { SOUL, withSoul } from '../../src/prompts/soul.js';

describe('SOUL', () => {
	it('loads SOUL.md content with all OpenClaw sections', () => {
		expect(SOUL).toContain('Stitch');
		expect(SOUL).toContain('personal productivity agent');
		expect(SOUL).toContain('Tone');
		expect(SOUL).toContain('Boundaries');
		expect(SOUL).toContain('Voice Examples');
	});

	it('withSoul prepends SOUL content to system prompt', () => {
		const prompt = 'You are a day planner.';
		const result = withSoul(prompt);
		expect(result).toContain('Stitch');
		expect(result).toContain('---');
		expect(result).toContain('You are a day planner.');
		expect(result.indexOf('Stitch')).toBeLessThan(result.indexOf('You are a day planner.'));
	});

	it('SOUL content is under 400 tokens (roughly 1500 chars)', () => {
		expect(SOUL.length).toBeLessThan(1500);
	});
});

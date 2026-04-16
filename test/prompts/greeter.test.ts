import { describe, expect, it } from 'vitest';
import {
	formatGap,
	GREETER_SYSTEM_PROMPT,
	GreetingResponseSchema,
} from '../../src/prompts/greeter.js';

/**
 * Phase 13 Plan 04 Task 1: greeter prompt, schema, and formatGap helper.
 *
 * 12 formatGap tests + 4 schema tests = 16 total.
 */

describe('formatGap', () => {
	it('returns empty string when lastEnd is null', () => {
		expect(formatGap(null, new Date('2026-04-16T12:00:00Z'))).toBe('');
	});

	it('returns "a moment" for 10s gap', () => {
		const now = new Date('2026-04-16T12:00:00Z');
		const lastEnd = new Date(now.getTime() - 10_000);
		expect(formatGap(lastEnd, now)).toBe('a moment');
	});

	it('returns "a moment" for 59s gap (boundary)', () => {
		const now = new Date('2026-04-16T12:00:00Z');
		const lastEnd = new Date(now.getTime() - 59_000);
		expect(formatGap(lastEnd, now)).toBe('a moment');
	});

	it('returns "1m" for 60s gap', () => {
		const now = new Date('2026-04-16T12:00:00Z');
		const lastEnd = new Date(now.getTime() - 60_000);
		expect(formatGap(lastEnd, now)).toBe('1m');
	});

	it('returns "45m" for 2700s gap', () => {
		const now = new Date('2026-04-16T12:00:00Z');
		const lastEnd = new Date(now.getTime() - 2_700_000);
		expect(formatGap(lastEnd, now)).toBe('45m');
	});

	it('returns "1h" for 3600s gap (omit 0m)', () => {
		const now = new Date('2026-04-16T12:00:00Z');
		const lastEnd = new Date(now.getTime() - 3_600_000);
		expect(formatGap(lastEnd, now)).toBe('1h');
	});

	it('returns "2h 14m" for 8040s gap', () => {
		const now = new Date('2026-04-16T12:00:00Z');
		const lastEnd = new Date(now.getTime() - 8_040_000);
		expect(formatGap(lastEnd, now)).toBe('2h 14m');
	});

	it('returns "1d" for 86400s gap with no sleep boundary', () => {
		// lastEnd at 12:00 yesterday, now at 12:00 today -- no sleep boundary crossed
		const now = new Date('2026-04-16T12:00:00Z');
		const lastEnd = new Date(now.getTime() - 86_400_000);
		expect(formatGap(lastEnd, now)).toBe('1d');
	});

	it('returns "overnight" when lastEnd is 23:30 and now is 07:00 next day', () => {
		const lastEnd = new Date('2026-04-15T23:30:00Z');
		const now = new Date('2026-04-16T07:00:00Z');
		expect(formatGap(lastEnd, now)).toBe('overnight');
	});

	it('returns "overnight" when lastEnd is 01:00 and now is 09:00 same day (crossed sleep)', () => {
		const lastEnd = new Date('2026-04-16T01:00:00Z');
		const now = new Date('2026-04-16T09:00:00Z');
		expect(formatGap(lastEnd, now)).toBe('overnight');
	});

	it('returns "8h" for same-waking-day gap (09:00 to 17:00)', () => {
		const lastEnd = new Date('2026-04-16T09:00:00Z');
		const now = new Date('2026-04-16T17:00:00Z');
		expect(formatGap(lastEnd, now)).toBe('8h');
	});

	it('returns "5d" for multi-day gap', () => {
		const now = new Date('2026-04-16T12:00:00Z');
		const lastEnd = new Date(now.getTime() - 5 * 86_400_000);
		expect(formatGap(lastEnd, now)).toBe('5d');
	});
});

describe('GreetingResponseSchema', () => {
	it('accepts valid greeting', () => {
		const result = GreetingResponseSchema.safeParse({ greeting: 'Welcome back.' });
		expect(result.success).toBe(true);
	});

	it('rejects greeting with exclamation mark', () => {
		const result = GreetingResponseSchema.safeParse({ greeting: 'Welcome back!' });
		expect(result.success).toBe(false);
	});

	it('rejects empty greeting (min 1)', () => {
		const result = GreetingResponseSchema.safeParse({ greeting: '' });
		expect(result.success).toBe(false);
	});

	it('rejects greeting exceeding 600 chars', () => {
		const result = GreetingResponseSchema.safeParse({ greeting: 'x'.repeat(601) });
		expect(result.success).toBe(false);
	});
});

describe('GREETER_SYSTEM_PROMPT', () => {
	it('contains "Never use exclamation marks" verbatim', () => {
		expect(GREETER_SYSTEM_PROMPT).toContain('Never use exclamation marks');
	});
});

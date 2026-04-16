import { describe, expect, it } from 'vitest';
import { TreeSetupResponseSchema } from '../../src/schemas/tree-setup.js';

/**
 * Phase 13 Wave 0: RED tests for TreeSetupResponseSchema.
 *
 * These tests INTENTIONALLY fail today because src/schemas/tree-setup.ts
 * does not exist yet. Wave 2 (Plan 03) creates it and turns these green.
 */

describe('TreeSetupResponseSchema', () => {
	it('accepts wrapper_text only (refinement mode)', () => {
		const parsed = TreeSetupResponseSchema.safeParse({
			wrapper_text:
				'I see you want a morning routine and a work block. Could you tell me when you wake and sleep?',
		});
		expect(parsed.success).toBe(true);
	});

	it('accepts wrapper_text + valid propose_tree (commit mode)', () => {
		const parsed = TreeSetupResponseSchema.safeParse({
			wrapper_text: 'Committed, Sir. Wake block 07:00-09:00, Day 09:00-21:00, Sleep 22:00-23:00.',
			propose_tree: {
				branches: [
					{
						name: 'Wake up',
						startTime: '07:00',
						endTime: '09:00',
						isTaskSlot: false,
						items: [{ label: 'Morning routine', type: 'fixed' }],
					},
					{
						name: 'Day',
						startTime: '09:00',
						endTime: '21:00',
						isTaskSlot: true,
					},
					{
						name: 'Sleep',
						startTime: '22:00',
						endTime: '23:00',
						isTaskSlot: false,
						items: [{ label: 'Lights off', type: 'fixed' }],
					},
				],
			},
		});
		expect(parsed.success).toBe(true);
	});

	it('accepts wrapper_text + propose_tree=null (Pitfall 3: nullish)', () => {
		const parsed = TreeSetupResponseSchema.safeParse({
			wrapper_text: 'Still refining. What time do you want dinner?',
			propose_tree: null,
		});
		expect(parsed.success).toBe(true);
	});

	it('rejects empty wrapper_text', () => {
		const parsed = TreeSetupResponseSchema.safeParse({
			wrapper_text: '',
		});
		expect(parsed.success).toBe(false);
	});

	it('rejects when wrapper_text missing', () => {
		const parsed = TreeSetupResponseSchema.safeParse({
			propose_tree: {
				branches: [
					{
						name: 'Day',
						startTime: '09:00',
						endTime: '21:00',
						isTaskSlot: true,
					},
				],
			},
		});
		expect(parsed.success).toBe(false);
	});
});

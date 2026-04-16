import { describe, expect, it } from 'vitest';
import {
	TREE_SETUP_HINTS,
	TREE_SETUP_MAX_HISTORY_CHARS,
	TREE_SETUP_SYSTEM_PROMPT,
	TREE_SETUP_WINDOW_ROWS,
} from '../../src/prompts/tree-setup.js';

describe('tree-setup prompts', () => {
	it('TREE_SETUP_WINDOW_ROWS === 30', () => {
		expect(TREE_SETUP_WINDOW_ROWS).toBe(30);
	});

	it('TREE_SETUP_MAX_HISTORY_CHARS === 12000', () => {
		expect(TREE_SETUP_MAX_HISTORY_CHARS).toBe(12000);
	});

	it('TREE_SETUP_HINTS is a frozen 7-element array of strings', () => {
		expect(TREE_SETUP_HINTS).toHaveLength(7);
		expect(Object.isFrozen(TREE_SETUP_HINTS)).toBe(true);
		for (const hint of TREE_SETUP_HINTS) {
			expect(typeof hint).toBe('string');
		}
	});

	it('TREE_SETUP_SYSTEM_PROMPT contains "propose_tree"', () => {
		expect(TREE_SETUP_SYSTEM_PROMPT).toContain('propose_tree');
	});

	it('TREE_SETUP_SYSTEM_PROMPT contains JARVIS voice rules', () => {
		// Must contain at least one of these JARVIS voice indicators
		const hasJarvisVoice =
			TREE_SETUP_SYSTEM_PROMPT.includes('JARVIS') ||
			TREE_SETUP_SYSTEM_PROMPT.includes('dry observations') ||
			TREE_SETUP_SYSTEM_PROMPT.includes('Never exclamation');
		expect(hasJarvisVoice).toBe(true);
	});

	it('TREE_SETUP_SYSTEM_PROMPT contains a "Hints:" block', () => {
		expect(TREE_SETUP_SYSTEM_PROMPT).toContain('Hints:');
	});

	it('TREE_SETUP_SYSTEM_PROMPT contains all 7 hints', () => {
		for (const hint of TREE_SETUP_HINTS) {
			expect(TREE_SETUP_SYSTEM_PROMPT).toContain(hint);
		}
	});
});

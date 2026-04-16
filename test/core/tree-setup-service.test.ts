import { describe, expect, it } from 'vitest';
import { DayTreeService } from '../../src/core/day-tree-service.js';
import {
	TREE_SETUP_HINTS,
	TREE_SETUP_WINDOW_ROWS,
	TreeSetupService,
} from '../../src/core/tree-setup-service.js';
import { createTestDb, seedConversations, seedSession } from '../helpers/db.js';
import { capturingLlm, ScriptedMockLlmProvider } from '../helpers/llm.js';
import { createTestLogger } from '../helpers/logger.js';

/**
 * Phase 13 Wave 0: RED unit tests for TreeSetupService.
 *
 * These tests INTENTIONALLY fail today because src/core/tree-setup-service.ts
 * does not exist yet. Wave 4 (Plan 05) creates it and turns these green.
 *
 * Covers D-11 (propose contract), D-12 (auto-commit), D-15 (hints injected),
 * D-18 (context window), Pitfall 5 (user row before LLM call ordering).
 */

const SAMPLE_TREE = {
	branches: [
		{ name: 'Wake', startTime: '07:00', endTime: '09:00', isTaskSlot: false },
		{ name: 'Day', startTime: '09:00', endTime: '21:00', isTaskSlot: true },
		{ name: 'Sleep', startTime: '22:00', endTime: '23:00', isTaskSlot: false },
	],
};

describe('TreeSetupService', () => {
	it('propose without propose_tree does NOT call commitProposedTree, writes 2 conversations rows, returns wrapper_text', async () => {
		const { llm, calls } = capturingLlm();
		const db = createTestDb();
		const logger = createTestLogger();
		const dayTreeService = new DayTreeService(db, llm, logger);

		llm.setFixture('tree_setup_response', {
			wrapper_text: 'I see you want a morning routine. When do you wake up?',
		});

		const sessionId = seedSession(db, { startedAt: '2026-04-16T09:00:00Z' });
		const service = new TreeSetupService({ db, llmProvider: llm, dayTreeService, logger });
		const result = await service.propose('I want a morning routine and a work block', logger);

		expect(result.wrapper_text).toBe('I see you want a morning routine. When do you wake up?');

		// 2 conversations rows: user + assistant
		const rows = db.$client.prepare('SELECT * FROM conversations').all();
		expect(rows.length).toBe(2);

		// No tree committed (propose_tree was absent)
		const tree = dayTreeService.getTree();
		expect(tree).toBeUndefined();
	});

	it('propose WITH propose_tree calls commitProposedTree and persists the tree', async () => {
		const { llm, calls } = capturingLlm();
		const db = createTestDb();
		const logger = createTestLogger();
		const dayTreeService = new DayTreeService(db, llm, logger);

		llm.setFixture('tree_setup_response', {
			wrapper_text: 'Committed, Sir. Wake 07:00, Day 09:00-21:00, Sleep 22:00.',
			propose_tree: SAMPLE_TREE,
		});

		const sessionId = seedSession(db, { startedAt: '2026-04-16T09:00:00Z' });
		const service = new TreeSetupService({ db, llmProvider: llm, dayTreeService, logger });
		await service.propose('wake 7am, day until 9pm, sleep at 10pm', logger);

		// Tree should now be committed
		const tree = dayTreeService.getTree();
		expect(tree).toBeDefined();
		expect(tree?.branches.length).toBe(3);
	});

	it('context window reads last TREE_SETUP_WINDOW_ROWS=30 rows regardless of trigger', async () => {
		const { llm, calls } = capturingLlm();
		const db = createTestDb();
		const logger = createTestLogger();
		const dayTreeService = new DayTreeService(db, llm, logger);

		// Seed 50 conversations rows
		const sessionId = seedSession(db, { startedAt: '2026-04-16T09:00:00Z' });
		const rows = [];
		for (let i = 0; i < 50; i++) {
			rows.push({
				role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
				content: `Message ${i}`,
				sessionId,
				triggeredBy: i % 5 === 0 ? 'tree_setup_reply' : null,
			});
		}
		seedConversations(db, rows);

		llm.setFixture('tree_setup_response', {
			wrapper_text: 'Noted. Continuing with your setup.',
		});

		const service = new TreeSetupService({ db, llmProvider: llm, dayTreeService, logger });
		await service.propose('add a dinner block at 7pm', logger);

		// The LLM should have been called (at least 1 call for tree_setup_response)
		expect(calls.length).toBeGreaterThanOrEqual(1);

		// The captured prompt should contain exactly 30 history rows (not 50)
		// We check the user prompt message for the last row content
		const userPrompt = calls[0].messages.find(
			(m: unknown) => (m as { role: string }).role === 'user',
		) as { content: string } | undefined;
		expect(userPrompt?.content).toBeDefined();
		// Should contain Message 49 (most recent) but NOT Message 19 (row 20 from end = excluded at 30-row window)
		expect(userPrompt?.content).toContain('Message 49');
		expect(userPrompt?.content).not.toContain('Message 19');
	});

	it('TREE_SETUP_HINTS constant is injected into the system prompt (contains wake-to-sleep)', async () => {
		const { llm, calls } = capturingLlm();
		const db = createTestDb();
		const logger = createTestLogger();
		const dayTreeService = new DayTreeService(db, llm, logger);

		llm.setFixture('tree_setup_response', {
			wrapper_text: 'Let me help you set up your day tree.',
		});

		const sessionId = seedSession(db, { startedAt: '2026-04-16T09:00:00Z' });
		const service = new TreeSetupService({ db, llmProvider: llm, dayTreeService, logger });
		await service.propose('set up my day', logger);

		expect(calls.length).toBeGreaterThanOrEqual(1);
		const systemPrompt = calls[0].messages.find(
			(m: unknown) => (m as { role: string }).role === 'system',
		) as { content: string } | undefined;
		expect(systemPrompt?.content).toBeDefined();
		expect(systemPrompt?.content).toContain('wake-to-sleep');
		expect(systemPrompt?.content).toContain('3-5 branches');
	});

	it('LLM call uses temperature 0.5 and thinking: false', async () => {
		const { llm, calls } = capturingLlm();
		const db = createTestDb();
		const logger = createTestLogger();
		const dayTreeService = new DayTreeService(db, llm, logger);

		llm.setFixture('tree_setup_response', {
			wrapper_text: 'Processing your request.',
		});

		const sessionId = seedSession(db, { startedAt: '2026-04-16T09:00:00Z' });
		const service = new TreeSetupService({ db, llmProvider: llm, dayTreeService, logger });
		await service.propose('set up my tree', logger);

		expect(calls.length).toBeGreaterThanOrEqual(1);
		expect(calls[0].temperature).toBe(0.5);
		expect(calls[0].thinking).toBe(false);
	});

	it('user row is INSERTed BEFORE the LLM call (Pitfall 5: ordering verified via LLM throw)', async () => {
		const llm = new ScriptedMockLlmProvider();
		const db = createTestDb();
		const logger = createTestLogger();
		const dayTreeService = new DayTreeService(db, llm, logger);

		// Make the LLM throw — the user row should still exist
		llm.setCallback('tree_setup_response', () => {
			throw new Error('LLM boom');
		});

		const sessionId = seedSession(db, { startedAt: '2026-04-16T09:00:00Z' });
		const service = new TreeSetupService({ db, llmProvider: llm, dayTreeService, logger });

		// propose should throw (LLM failure)
		await expect(service.propose('build my tree', logger)).rejects.toThrow('LLM boom');

		// User row should exist (inserted before LLM call)
		const allRows = db.$client.prepare('SELECT * FROM conversations').all() as Array<{
			role: string;
		}>;
		const userRows = allRows.filter((r) => r.role === 'user');
		expect(userRows.length).toBe(1);

		// No assistant row (LLM failed before it could be written)
		const assistantRows = allRows.filter((r) => r.role === 'assistant');
		expect(assistantRows.length).toBe(0);
	});
});

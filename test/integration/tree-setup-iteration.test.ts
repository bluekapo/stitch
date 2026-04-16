import { describe, expect, it, vi } from 'vitest';
import { routeTextInput } from '../../src/channels/telegram/handlers/text-router.js';
import { DayTreeService } from '../../src/core/day-tree-service.js';
import { IntentClassifierService } from '../../src/core/intent-classifier.js';
import { TaskParserService } from '../../src/core/task-parser.js';
import { TaskService } from '../../src/core/task-service.js';
import { TreeSetupService } from '../../src/core/tree-setup-service.js';
import { createTestDb, seedSession } from '../helpers/db.js';
import { ScriptedMockLlmProvider } from '../helpers/llm.js';
import { createTestLogger } from '../helpers/logger.js';

/**
 * Phase 13 Wave 0: RED multi-turn integration test for tree_setup -> tree_confirm.
 *
 * These tests INTENTIONALLY fail today because TreeSetupService does not
 * exist yet. Wave 4 (Plan 05) creates it and turns these green.
 *
 * Covers: iterative tree_setup refines committed tree, tree_confirm exits
 * tree-setup mode with conversations row.
 */

const SAMPLE_TREE_V1 = {
	branches: [
		{ name: 'Wake', startTime: '07:00', endTime: '09:00', isTaskSlot: false },
		{ name: 'Day', startTime: '09:00', endTime: '21:00', isTaskSlot: true },
		{ name: 'Sleep', startTime: '22:00', endTime: '23:00', isTaskSlot: false },
	],
};

const SAMPLE_TREE_V2 = {
	branches: [
		{ name: 'Wake', startTime: '07:00', endTime: '09:00', isTaskSlot: false },
		{ name: 'Day', startTime: '09:00', endTime: '19:00', isTaskSlot: true },
		{ name: 'Dinner', startTime: '19:00', endTime: '20:00', isTaskSlot: false },
		{ name: 'Evening', startTime: '20:00', endTime: '22:00', isTaskSlot: true },
		{ name: 'Sleep', startTime: '22:00', endTime: '23:00', isTaskSlot: false },
	],
};

describe('tree-setup iteration (Phase 13 integration)', () => {
	it('two tree_setup turns refine the tree, third tree_confirm exits', async () => {
		const db = createTestDb();
		const llm = new ScriptedMockLlmProvider();
		const logger = createTestLogger();
		const taskService = new TaskService(db, logger);
		const parser = new TaskParserService(llm, logger);
		const dayTreeService = new DayTreeService(db, llm, logger);
		const intentClassifierService = new IntentClassifierService(
			llm,
			dayTreeService,
			taskService,
			logger,
		);
		const treeSetupService = new TreeSetupService({
			db,
			llmProvider: llm,
			dayTreeService,
			logger,
		});

		const sessionId = seedSession(db, { startedAt: '2026-04-16T09:00:00Z' });

		// --- Turn 1: classify -> tree_setup, propose v1 tree ---
		llm.setFixture('intent_classifier', {
			intent: 'tree_setup',
			confidence: 0.9,
		});
		llm.setFixture('tree_setup_response', {
			wrapper_text: 'Committed, Sir. Basic 3-branch tree.',
			propose_tree: SAMPLE_TREE_V1,
		});

		const r1 = await routeTextInput('wake 7am, work until 9pm, sleep at 10', {
			taskService,
			parser,
			dayTreeService,
			intentClassifierService,
			treeSetupService,
			logger,
		});
		expect(r1.reply).toContain('Committed');

		// Tree v1 should be committed
		const tree1 = dayTreeService.getTree();
		expect(tree1?.branches.length).toBe(3);

		// --- Turn 2: classify -> tree_setup again, propose v2 tree ---
		llm.setFixture('intent_classifier', {
			intent: 'tree_setup',
			confidence: 0.88,
		});
		llm.setFixture('tree_setup_response', {
			wrapper_text: 'Updated, Sir. Added dinner and evening blocks.',
			propose_tree: SAMPLE_TREE_V2,
		});

		const r2 = await routeTextInput('add dinner at 7pm and an evening block', {
			taskService,
			parser,
			dayTreeService,
			intentClassifierService,
			treeSetupService,
			logger,
		});
		expect(r2.reply).toContain('Updated');

		// Tree v2 should have overwritten v1
		const tree2 = dayTreeService.getTree();
		expect(tree2?.branches.length).toBe(5);

		// --- Turn 3: classify -> tree_confirm ---
		llm.setFixture('intent_classifier', {
			intent: 'tree_confirm',
			confidence: 0.95,
		});

		const r3 = await routeTextInput('the tree is perfect', {
			taskService,
			parser,
			dayTreeService,
			intentClassifierService,
			treeSetupService,
			logger,
		});

		// tree_confirm should reply with a confirmation, NOT call TreeSetupService
		expect(r3.reply).toBeTruthy();

		// Verify conversations rows: should have tree_setup_reply and tree_confirm_reply triggered_by values
		const treeSetupReplies = db.$client
			.prepare("SELECT * FROM conversations WHERE triggered_by = 'tree_setup_reply'")
			.all();
		expect(treeSetupReplies.length).toBeGreaterThanOrEqual(2);

		const treeConfirmReplies = db.$client
			.prepare("SELECT * FROM conversations WHERE triggered_by = 'tree_confirm_reply'")
			.all();
		expect(treeConfirmReplies.length).toBeGreaterThanOrEqual(1);
	});

	it('tree_confirm writes conversations row but does NOT call TreeSetupService', async () => {
		const db = createTestDb();
		const llm = new ScriptedMockLlmProvider();
		const logger = createTestLogger();
		const taskService = new TaskService(db, logger);
		const parser = new TaskParserService(llm, logger);
		const dayTreeService = new DayTreeService(db, llm, logger);
		const intentClassifierService = new IntentClassifierService(
			llm,
			dayTreeService,
			taskService,
			logger,
		);
		const treeSetupService = new TreeSetupService({
			db,
			llmProvider: llm,
			dayTreeService,
			logger,
		});

		// Seed a tree so tree is not missing
		db.$client
			.prepare('INSERT INTO day_trees (tree) VALUES (?)')
			.run(JSON.stringify(SAMPLE_TREE_V1));

		const sessionId = seedSession(db, { startedAt: '2026-04-16T09:00:00Z' });

		llm.setFixture('intent_classifier', {
			intent: 'tree_confirm',
			confidence: 0.95,
		});

		// No tree_setup_response fixture needed — tree_confirm should NOT call TreeSetupService

		const result = await routeTextInput('looks good', {
			taskService,
			parser,
			dayTreeService,
			intentClassifierService,
			treeSetupService,
			logger,
		});

		expect(result.reply).toBeTruthy();

		// tree_confirm_reply row should exist
		const confirmRows = db.$client
			.prepare("SELECT * FROM conversations WHERE triggered_by = 'tree_confirm_reply'")
			.all();
		expect(confirmRows.length).toBe(1);
	});
});

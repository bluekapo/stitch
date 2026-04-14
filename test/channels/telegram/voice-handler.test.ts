import type { Bot } from 'grammy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerVoiceHandler } from '../../../src/channels/telegram/handlers/voice-handler.js';
import type { StitchContext } from '../../../src/channels/telegram/types.js';
import { DayTreeService } from '../../../src/core/day-tree-service.js';
import { IntentClassifierService } from '../../../src/core/intent-classifier.js';
import type { TaskParserService } from '../../../src/core/task-parser.js';
import { TaskService } from '../../../src/core/task-service.js';
import { MockLlmProvider } from '../../../src/providers/mock.js';
import type { SttProvider } from '../../../src/providers/stt.js';
import { createTestDb } from '../../helpers/db.js';
import { createTestBot, fakeVoiceMessageUpdate } from '../../helpers/telegram.js';

function createMockStt(transcribeResult: string): SttProvider {
	return {
		transcribe: async () => ({ text: transcribeResult }),
		healthCheck: async () => ({ ok: true }),
	};
}

function createFailingStt(): SttProvider {
	return {
		transcribe: async () => {
			throw new Error('STT server unavailable');
		},
		healthCheck: async () => ({ ok: false, error: 'down' }),
	};
}

const mockParser = {
	parse: async (text: string) => ({
		name: text,
		description: undefined,
		isEssential: false,
		taskType: 'ad-hoc' as const,
		deadline: undefined,
		recurrenceDay: undefined,
	}),
} as unknown as TaskParserService;

describe('voice-handler', () => {
	let bot: Bot<StitchContext>;
	let outgoing: Array<{ method: string; payload: unknown }>;
	let taskService: TaskService;

	beforeEach(async () => {
		const db = createTestDb();
		taskService = new TaskService(db);

		const result = createTestBot();
		bot = result.bot;
		outgoing = result.outgoing;

		// Mock global fetch for Telegram file download
		vi.stubGlobal('fetch', async () => ({
			ok: true,
			arrayBuffer: async () => new ArrayBuffer(8),
		}));
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	function getReplyText(): string {
		const send = outgoing.find((o) => o.method === 'sendMessage');
		return ((send?.payload as Record<string, unknown>)?.text as string) ?? '';
	}

	// Test 1: Voice message triggers transcription and creates task via classifier dispatch
	it('voice message triggers transcription and creates task via classifier dispatch', async () => {
		const llm = new MockLlmProvider();
		const dayTreeService = new DayTreeService(createTestDb(), llm);
		const intentClassifierService = new IntentClassifierService(llm, dayTreeService, taskService);
		llm.setFixture('intent_classifier', {
			intent: 'task_create',
			confidence: 0.95,
			suggested_chunk_id: null,
			suggested_branch_name: null,
			is_essential: false,
		});

		const stt = createMockStt('add buy groceries');
		registerVoiceHandler({
			bot,
			sttProvider: stt,
			taskService,
			parser: mockParser,
			botToken: 'fake:token',
			intentClassifierService,
		});
		await bot.init();

		await bot.handleUpdate(fakeVoiceMessageUpdate() as never);
		expect(getReplyText()).toContain('Task created');
	});

	// Test 2: Voice message lists tasks via classifier (task_query)
	it('voice message lists tasks via classifier task_query', async () => {
		taskService.create({ name: 'Existing Task' });

		const llm = new MockLlmProvider();
		const dayTreeService = new DayTreeService(createTestDb(), llm);
		const intentClassifierService = new IntentClassifierService(llm, dayTreeService, taskService);
		llm.setFixture('intent_classifier', {
			intent: 'task_query',
			confidence: 0.95,
		});

		const stt = createMockStt('list');
		registerVoiceHandler({
			bot,
			sttProvider: stt,
			taskService,
			parser: mockParser,
			botToken: 'fake:token',
			intentClassifierService,
		});
		await bot.init();

		await bot.handleUpdate(fakeVoiceMessageUpdate() as never);
		expect(getReplyText()).toContain('Existing Task');
	});

	// Test 3: Voice NL text routes through classifier task_create
	it('voice message with NL text routes through classifier task_create', async () => {
		const llm = new MockLlmProvider();
		const dayTreeService = new DayTreeService(createTestDb(), llm);
		const intentClassifierService = new IntentClassifierService(llm, dayTreeService, taskService);
		llm.setFixture('intent_classifier', {
			intent: 'task_create',
			confidence: 0.9,
			suggested_chunk_id: null,
			suggested_branch_name: null,
			is_essential: false,
		});

		const stt = createMockStt('I need to buy groceries tomorrow');
		registerVoiceHandler({
			bot,
			sttProvider: stt,
			taskService,
			parser: mockParser,
			botToken: 'fake:token',
			intentClassifierService,
		});
		await bot.init();

		await bot.handleUpdate(fakeVoiceMessageUpdate() as never);
		expect(getReplyText()).toContain('Task created');
	});

	// Test 4: Empty transcription replies with error message (UNCHANGED behavior, signature update only)
	it('empty transcription replies with error message', async () => {
		const stt = createMockStt('');
		registerVoiceHandler({
			bot,
			sttProvider: stt,
			taskService,
			parser: mockParser,
			botToken: 'fake:token',
		});
		await bot.init();

		await bot.handleUpdate(fakeVoiceMessageUpdate() as never);
		expect(getReplyText()).toContain('Could not understand the voice message.');
	});

	// Test 5: STT failure replies with error message (UNCHANGED behavior, signature update only)
	it('STT failure replies with error message', async () => {
		const stt = createFailingStt();
		registerVoiceHandler({
			bot,
			sttProvider: stt,
			taskService,
			parser: mockParser,
			botToken: 'fake:token',
		});
		await bot.init();

		await bot.handleUpdate(fakeVoiceMessageUpdate() as never);
		expect(getReplyText()).toContain('Voice transcription failed');
	});

	// Test 6: Voice message and reply scheduled for cleanup (UNCHANGED behavior, signature + classifier update)
	it('voice message and reply scheduled for cleanup', async () => {
		vi.useFakeTimers();
		const llm = new MockLlmProvider();
		const dayTreeService = new DayTreeService(createTestDb(), llm);
		const intentClassifierService = new IntentClassifierService(llm, dayTreeService, taskService);
		llm.setFixture('intent_classifier', {
			intent: 'task_create',
			confidence: 0.9,
			suggested_chunk_id: null,
			suggested_branch_name: null,
			is_essential: false,
		});

		const stt = createMockStt('add test cleanup');
		registerVoiceHandler({
			bot,
			sttProvider: stt,
			taskService,
			parser: mockParser,
			botToken: 'fake:token',
			intentClassifierService,
		});
		await bot.init();

		await bot.handleUpdate(fakeVoiceMessageUpdate() as never);

		// Advance timers past CLEANUP_DELAY_MS (60000ms)
		await vi.advanceTimersByTimeAsync(61_000);

		const deleteCalls = outgoing.filter((o) => o.method === 'deleteMessage');
		// Should have 2 deleteMessage calls: voice msg + bot reply
		expect(deleteCalls.length).toBe(2);
		vi.useRealTimers();
	});

	// Test 7: File download failure replies with error
	it('file download failure replies with error', async () => {
		vi.stubGlobal('fetch', async () => ({
			ok: false,
			status: 500,
			statusText: 'Internal Server Error',
		}));

		const stt = createMockStt('should not reach');
		registerVoiceHandler({
			bot,
			sttProvider: stt,
			taskService,
			parser: mockParser,
			botToken: 'fake:token',
		});
		await bot.init();

		await bot.handleUpdate(fakeVoiceMessageUpdate() as never);
		expect(getReplyText()).toContain('Voice transcription failed');
	});
});

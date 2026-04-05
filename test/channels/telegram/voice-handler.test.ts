import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestBot, fakeVoiceMessageUpdate } from '../../helpers/telegram.js';
import { createTestDb } from '../../helpers/db.js';
import { TaskService } from '../../../src/core/task-service.js';
import { registerVoiceHandler } from '../../../src/channels/telegram/handlers/voice-handler.js';
import type { Bot } from 'grammy';
import type { StitchContext } from '../../../src/channels/telegram/types.js';
import type { SttProvider } from '../../../src/providers/stt.js';
import type { TaskParserService } from '../../../src/core/task-parser.js';

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
		description: null,
		isEssential: false,
		taskType: 'ad-hoc' as const,
		deadline: null,
		recurrenceDay: undefined,
	}),
} as TaskParserService;

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

	function getAllReplyTexts(): string[] {
		return outgoing
			.filter((o) => o.method === 'sendMessage')
			.map((o) => ((o.payload as Record<string, unknown>)?.text as string) ?? '');
	}

	// Test 1: Voice message triggers transcription and creates task via 'add' command
	it('voice message triggers transcription and creates task via add command', async () => {
		const stt = createMockStt('add buy groceries');
		registerVoiceHandler(bot, stt, taskService, mockParser, 'fake:token');
		await bot.init();

		await bot.handleUpdate(fakeVoiceMessageUpdate() as never);
		expect(getReplyText()).toContain('Task created: buy groceries');
	});

	// Test 2: Voice message triggers transcription and lists tasks via 'list' command
	it('voice message triggers transcription and lists tasks via list command', async () => {
		taskService.create({ name: 'Existing Task' });
		const stt = createMockStt('list');
		registerVoiceHandler(bot, stt, taskService, mockParser, 'fake:token');
		await bot.init();

		await bot.handleUpdate(fakeVoiceMessageUpdate() as never);
		expect(getReplyText()).toContain('Existing Task');
	});

	// Test 3: Voice NL text falls through to parser
	it('voice message with NL text falls through to parser', async () => {
		const stt = createMockStt('I need to buy groceries tomorrow');
		registerVoiceHandler(bot, stt, taskService, mockParser, 'fake:token');
		await bot.init();

		await bot.handleUpdate(fakeVoiceMessageUpdate() as never);
		expect(getReplyText()).toContain('Task created:');
	});

	// Test 4: Empty transcription replies with error message
	it('empty transcription replies with error message', async () => {
		const stt = createMockStt('');
		registerVoiceHandler(bot, stt, taskService, mockParser, 'fake:token');
		await bot.init();

		await bot.handleUpdate(fakeVoiceMessageUpdate() as never);
		expect(getReplyText()).toContain('Could not understand the voice message.');
	});

	// Test 5: STT failure replies with error message
	it('STT failure replies with error message', async () => {
		const stt = createFailingStt();
		registerVoiceHandler(bot, stt, taskService, mockParser, 'fake:token');
		await bot.init();

		await bot.handleUpdate(fakeVoiceMessageUpdate() as never);
		expect(getReplyText()).toContain('Voice transcription failed');
	});

	// Test 6: Voice message and reply scheduled for cleanup
	it('voice message and reply scheduled for cleanup', async () => {
		vi.useFakeTimers();
		const stt = createMockStt('add test cleanup');
		registerVoiceHandler(bot, stt, taskService, mockParser, 'fake:token');
		await bot.init();

		await bot.handleUpdate(fakeVoiceMessageUpdate() as never);

		// Advance timers past CLEANUP_DELAY_MS (3000ms)
		await vi.advanceTimersByTimeAsync(4000);

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
		registerVoiceHandler(bot, stt, taskService, mockParser, 'fake:token');
		await bot.init();

		await bot.handleUpdate(fakeVoiceMessageUpdate() as never);
		expect(getReplyText()).toContain('Voice transcription failed');
	});
});

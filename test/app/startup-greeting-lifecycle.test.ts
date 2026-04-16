import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Bot } from 'grammy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { StitchContext } from '../../src/channels/telegram/types.js';
import { MockLlmProvider } from '../../src/providers/mock.js';
import { MockSttProvider } from '../../src/providers/mock-stt.js';
import { createTestDb } from '../helpers/db.js';

/**
 * Phase 13 Wave 0: RED integration test for startup greeting lifecycle.
 *
 * These tests INTENTIONALLY fail today because StartupGreetingService is
 * not yet wired into buildApp/onReady. Wave 3 (Plan 04) adds the wiring
 * and turns these green.
 *
 * Covers: onReady fires greeter, conversations row written, late-bind bot works.
 */

const testLogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stitch-greeting-test-'));
const TEST_USER_CHAT_ID = 42;

function buildMockBot() {
	const sendMessage = vi.fn().mockResolvedValue({ message_id: 1234 });
	const bot = {
		api: {
			sendMessage,
			deleteMessage: vi.fn().mockResolvedValue(true),
			getChat: vi.fn().mockResolvedValue({ id: TEST_USER_CHAT_ID }),
		},
		on: vi.fn(),
		command: vi.fn(),
		use: vi.fn(),
	} as unknown as Bot<StitchContext>;
	return { bot, sendMessage };
}

describe('startup-greeting lifecycle (Phase 13)', () => {
	let app: FastifyInstance | undefined;

	afterEach(async () => {
		if (app) {
			await app.close();
			app = undefined;
		}
	});

	it('onReady fires greeter: conversations row written, bot.api.sendMessage called', async () => {
		const db = createTestDb();
		const llm = new MockLlmProvider();
		const stt = new MockSttProvider();
		const { bot, sendMessage } = buildMockBot();

		// Fixture for the startup greeting LLM call
		llm.setFixture('startup_greeting', {
			greeting: 'Good evening, Sir. I am Stitch.',
		});

		app = buildApp({
			config: {
				PORT: 0,
				LOG_LEVEL: 'silent' as const,
				LOG_DIR: testLogDir,
				LLAMA_SERVER_URL: 'http://localhost:8080',
				LLAMA_MODEL_NAME: 'test-model',
				LLM_PROVIDER: 'mock' as const,
				LLM_MAX_RETRIES: 1,
				DATABASE_URL: ':memory:',
				WHISPER_SERVER_URL: 'http://localhost:8081',
				STT_PROVIDER: 'mock' as const,
				TELEGRAM_BOT_TOKEN: '',
				TELEGRAM_ALLOWED_USER_ID: TEST_USER_CHAT_ID,
				RECURRENCE_CRON_TIME: '0 5 * * *',
				NUDGE_TICK_INTERVAL_MS: 30000,
				WAKE_SECRET: 'test-wake-secret-do-not-use-in-prod-12345',
				WAKE_DEBOUNCE_MS: 300000,
				CHECKIN_CLEANUP_MS: 900000,
			},
			llmProvider: llm,
			sttProvider: stt,
			db,
			telegramBot: bot,
		});

		await app.ready();

		// Verify sendMessage was called with the greeting
		expect(sendMessage).toHaveBeenCalledTimes(1);

		// Verify conversations row was written
		const rows = db.$client.prepare("SELECT * FROM conversations WHERE role = 'assistant'").all();
		expect(rows.length).toBeGreaterThanOrEqual(1);
	});
});

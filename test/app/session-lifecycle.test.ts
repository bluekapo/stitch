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
 * Phase 13 Wave 0: RED integration test for session lifecycle.
 *
 * These tests INTENTIONALLY fail today because sessions table creation
 * and session start/end wiring are not yet in buildApp/onReady/onClose.
 * Wave 1 (Plan 02) adds the session lifecycle and turns these green.
 *
 * Covers: session row created onReady, ended_at on onClose, crash leaves null.
 */

const testLogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stitch-session-test-'));
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

function makeTestConfig() {
	return {
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
	};
}

describe('session lifecycle (Phase 13)', () => {
	let app: FastifyInstance | undefined;

	afterEach(async () => {
		if (app) {
			await app.close();
			app = undefined;
		}
	});

	it('onReady creates a sessions row with non-null started_at and null ended_at', async () => {
		const db = createTestDb();
		const llm = new MockLlmProvider();
		const stt = new MockSttProvider();
		const { bot } = buildMockBot();

		app = buildApp({
			config: makeTestConfig(),
			llmProvider: llm,
			sttProvider: stt,
			db,
			telegramBot: bot,
		});

		await app.ready();

		const rows = db.$client.prepare('SELECT * FROM sessions').all() as Array<{
			started_at: string;
			ended_at: string | null;
		}>;
		expect(rows.length).toBeGreaterThanOrEqual(1);
		const latest = rows[rows.length - 1];
		expect(latest.started_at).toBeTruthy();
		expect(latest.ended_at).toBeNull();
	});

	it('app.close() writes ended_at to the current session row', async () => {
		const db = createTestDb();
		const llm = new MockLlmProvider();
		const stt = new MockSttProvider();
		const { bot } = buildMockBot();

		app = buildApp({
			config: makeTestConfig(),
			llmProvider: llm,
			sttProvider: stt,
			db,
			telegramBot: bot,
		});

		await app.ready();
		await app.close();
		app = undefined; // prevent afterEach double-close

		const rows = db.$client.prepare('SELECT * FROM sessions').all() as Array<{
			started_at: string;
			ended_at: string | null;
		}>;
		expect(rows.length).toBeGreaterThanOrEqual(1);
		const latest = rows[rows.length - 1];
		expect(latest.ended_at).toBeTruthy();
	});

	it('crash (no close) leaves ended_at null, next boot cleanupOrphanedSessions heals it', async () => {
		const db = createTestDb();
		const llm = new MockLlmProvider();
		const stt = new MockSttProvider();
		const { bot } = buildMockBot();

		// First boot — simulate crash by NOT calling close()
		const app1 = buildApp({
			config: makeTestConfig(),
			llmProvider: llm,
			sttProvider: stt,
			db,
			telegramBot: bot,
		});
		await app1.ready();
		// Intentionally skip app1.close() to simulate crash

		// The session row should have null ended_at
		const rowsBefore = db.$client.prepare('SELECT * FROM sessions').all() as Array<{
			id: number;
			started_at: string;
			ended_at: string | null;
		}>;
		const crashedRow = rowsBefore[rowsBefore.length - 1];
		expect(crashedRow.ended_at).toBeNull();

		// Second boot — cleanupOrphanedSessions should heal the prior row
		const { bot: bot2 } = buildMockBot();
		app = buildApp({
			config: makeTestConfig(),
			llmProvider: llm,
			sttProvider: stt,
			db,
			telegramBot: bot2,
		});
		await app.ready();

		// Check the orphaned row was healed (ended_at = started_at)
		const healedRow = db.$client
			.prepare('SELECT * FROM sessions WHERE id = ?')
			.get(crashedRow.id) as {
			started_at: string;
			ended_at: string | null;
		};
		expect(healedRow.ended_at).toBe(healedRow.started_at);
	});
});

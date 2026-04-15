import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import type { AppConfig } from '../../src/config.js';
import type { StitchDb } from '../../src/db/index.js';
import type { LlmProvider } from '../../src/providers/llm.js';
import type { SttProvider } from '../../src/providers/stt.js';
import { createTestDb } from './db.js';

/**
 * Phase 12 note: `LOG_DIR` defaults to a per-process tmpdir so tests never
 * pollute the repo's `./data/logs` directory. Individual tests that care
 * about rotation (e.g. `test/app/logger-lifecycle.test.ts`) pass their own
 * LOG_DIR via `overrides`.
 */
const defaultLogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stitch-test-logs-'));

const testConfig: AppConfig = {
	PORT: 0,
	LOG_LEVEL: 'silent' as const,
	LOG_DIR: defaultLogDir,
	LLAMA_SERVER_URL: 'http://localhost:8080',
	LLAMA_MODEL_NAME: 'test-model',
	LLM_PROVIDER: 'mock' as const,
	LLM_MAX_RETRIES: 1,
	DATABASE_URL: ':memory:',
	WHISPER_SERVER_URL: 'http://localhost:8081',
	STT_PROVIDER: 'mock' as const,
	TELEGRAM_BOT_TOKEN: '',
	TELEGRAM_ALLOWED_USER_ID: undefined,
	// Latent bug fix: RECURRENCE_CRON_TIME was missing from test config
	RECURRENCE_CRON_TIME: '0 5 * * *',
	// Phase 9 additions
	NUDGE_TICK_INTERVAL_MS: 30000,
	WAKE_SECRET: 'test-wake-secret-do-not-use-in-prod-12345', // 41 chars > 16 min
	WAKE_DEBOUNCE_MS: 300000,
	CHECKIN_CLEANUP_MS: 900000,
};

export function buildTestApp(
	overrides?: Partial<AppConfig>,
	providers?: { llmProvider?: LlmProvider; sttProvider?: SttProvider; db?: StitchDb },
): FastifyInstance {
	const db = providers?.db ?? createTestDb();
	// The lifecycle test reads LOG_DIR from process.env and relies on
	// buildTestApp honouring it — surface the env var as an override when
	// the caller hasn't supplied one explicitly.
	const envLogDir = process.env.LOG_DIR;
	const resolvedOverrides: Partial<AppConfig> = { ...overrides };
	if (envLogDir && !resolvedOverrides.LOG_DIR) {
		resolvedOverrides.LOG_DIR = envLogDir;
	}
	return buildApp({
		config: { ...testConfig, ...resolvedOverrides },
		llmProvider: providers?.llmProvider,
		sttProvider: providers?.sttProvider,
		db,
	});
}

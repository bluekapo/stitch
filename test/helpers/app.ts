import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import type { AppConfig } from '../../src/config.js';
import type { StitchDb } from '../../src/db/index.js';
import type { LlmProvider } from '../../src/providers/llm.js';
import type { SttProvider } from '../../src/providers/stt.js';
import { createTestDb } from './db.js';

const testConfig: AppConfig = {
	PORT: 0,
	LOG_LEVEL: 'silent' as const,
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
	return buildApp({
		config: { ...testConfig, ...overrides },
		llmProvider: providers?.llmProvider,
		sttProvider: providers?.sttProvider,
		db,
	});
}

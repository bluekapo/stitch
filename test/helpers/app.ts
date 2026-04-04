import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import type { AppConfig } from '../../src/config.js';
import type { StitchDb } from '../../src/db/index.js';
import type { LlmProvider } from '../../src/providers/llm.js';
import { createTestDb } from './db.js';

const testConfig: AppConfig = {
	PORT: 0,
	LOG_LEVEL: 'silent' as const,
	LLAMA_SERVER_URL: 'http://localhost:8080',
	LLAMA_MODEL_NAME: 'test-model',
	LLM_PROVIDER: 'mock' as const,
	LLM_MAX_RETRIES: 1,
	DATABASE_URL: ':memory:',
};

export function buildTestApp(
	overrides?: Partial<AppConfig>,
	providers?: { llmProvider?: LlmProvider; db?: StitchDb },
): FastifyInstance {
	const db = providers?.db ?? createTestDb();
	return buildApp({
		config: { ...testConfig, ...overrides },
		llmProvider: providers?.llmProvider,
		db,
	});
}

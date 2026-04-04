import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import type { AppConfig } from '../../src/config.js';
import type { LlmProvider } from '../../src/providers/llm.js';

const testConfig: AppConfig = {
	PORT: 0,
	LOG_LEVEL: 'silent' as const,
	LLAMA_SERVER_URL: 'http://localhost:8080',
	LLAMA_MODEL_NAME: 'test-model',
	LLM_PROVIDER: 'mock' as const,
	LLM_MAX_RETRIES: 1,
};

export function buildTestApp(
	overrides?: Partial<AppConfig>,
	llmProvider?: LlmProvider,
): FastifyInstance {
	return buildApp({
		config: { ...testConfig, ...overrides },
		llmProvider,
	});
}

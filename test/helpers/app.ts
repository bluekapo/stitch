import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import type { AppConfig } from '../../src/config.js';
import type { LlmProvider } from '../../src/providers/llm.js';
import type { SttProvider } from '../../src/providers/stt.js';

const testConfig: AppConfig = {
	PORT: 0,
	LOG_LEVEL: 'silent' as const,
	LLAMA_SERVER_URL: 'http://localhost:8080',
	LLAMA_MODEL_NAME: 'test-model',
	LLM_PROVIDER: 'mock' as const,
	LLM_MAX_RETRIES: 1,
	WHISPER_SERVER_URL: 'http://localhost:8081',
	STT_PROVIDER: 'mock' as const,
};

export function buildTestApp(
	overrides?: Partial<AppConfig>,
	providers?: { llmProvider?: LlmProvider; sttProvider?: SttProvider },
): FastifyInstance {
	return buildApp({
		config: { ...testConfig, ...overrides },
		llmProvider: providers?.llmProvider,
		sttProvider: providers?.sttProvider,
	});
}

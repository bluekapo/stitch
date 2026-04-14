import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../src/config.js';
import { createLlmProvider } from '../../src/providers/index.js';
import { LlamaServerProvider } from '../../src/providers/llama-server.js';
import { MockLlmProvider } from '../../src/providers/mock.js';
import { TaskAnalysisSchema } from '../../src/schemas/llm.js';

const validTaskAnalysis = {
	taskName: 'Write unit tests',
	estimatedMinutes: 30,
	category: 'work',
	subtasks: ['Setup test framework', 'Write test cases'],
};

/** Override the OpenAI client on a LlamaServerProvider for testing */
function overrideClient(provider: LlamaServerProvider, createMock: ReturnType<typeof vi.fn>): void {
	(provider as unknown as { client: unknown }).client = {
		chat: { completions: { create: createMock } },
	};
}

describe('LlamaServerProvider', () => {
	describe('healthCheck', () => {
		afterEach(() => {
			vi.restoreAllMocks();
		});

		it('returns { ok: false } when server is unreachable', async () => {
			const provider = new LlamaServerProvider({
				baseURL: 'http://localhost:99999',
				model: 'test-model',
			});

			const result = await provider.healthCheck();
			expect(result.ok).toBe(false);
			expect(result.error).toBeDefined();
		});

		it('returns { ok: true } when server responds 200', async () => {
			vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
				new Response(JSON.stringify({ status: 'ok' }), { status: 200 }),
			);

			const provider = new LlamaServerProvider({
				baseURL: 'http://localhost:8080',
				model: 'test-model',
			});

			const result = await provider.healthCheck();
			expect(result.ok).toBe(true);
		});

		it('returns { ok: false } with error message when server responds 503', async () => {
			vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
				new Response(JSON.stringify({ error: 'model loading' }), {
					status: 503,
				}),
			);

			const provider = new LlamaServerProvider({
				baseURL: 'http://localhost:8080',
				model: 'test-model',
			});

			const result = await provider.healthCheck();
			expect(result.ok).toBe(false);
			expect(result.error).toBeDefined();
		});
	});

	describe('complete', () => {
		afterEach(() => {
			vi.restoreAllMocks();
		});

		it('retries on empty content and succeeds on second attempt', async () => {
			const provider = new LlamaServerProvider({
				baseURL: 'http://localhost:8080',
				model: 'test-model',
				maxRetries: 2,
			});

			const createMock = vi
				.fn()
				.mockResolvedValueOnce({
					choices: [{ message: { content: '' } }],
				})
				.mockResolvedValueOnce({
					choices: [{ message: { content: JSON.stringify(validTaskAnalysis) } }],
				});

			overrideClient(provider, createMock);

			const result = await provider.complete({
				messages: [{ role: 'user', content: 'Analyze task' }],
				schema: TaskAnalysisSchema,
				schemaName: 'task-analysis',
			});

			expect(result).toEqual(validTaskAnalysis);
			expect(createMock).toHaveBeenCalledTimes(2);
		});

		it('retries on Zod validation failure and succeeds on second attempt', async () => {
			const provider = new LlamaServerProvider({
				baseURL: 'http://localhost:8080',
				model: 'test-model',
				maxRetries: 2,
			});

			const invalidResponse = {
				taskName: 'Bad',
				estimatedMinutes: 'not-a-number',
				category: 'invalid',
				subtasks: 'not-an-array',
			};

			const createMock = vi
				.fn()
				.mockResolvedValueOnce({
					choices: [{ message: { content: JSON.stringify(invalidResponse) } }],
				})
				.mockResolvedValueOnce({
					choices: [{ message: { content: JSON.stringify(validTaskAnalysis) } }],
				});

			overrideClient(provider, createMock);

			const result = await provider.complete({
				messages: [{ role: 'user', content: 'Analyze task' }],
				schema: TaskAnalysisSchema,
				schemaName: 'task-analysis',
			});

			expect(result).toEqual(validTaskAnalysis);
			expect(createMock).toHaveBeenCalledTimes(2);
		});

		it('throws after exhausting retries with validation failures', async () => {
			const provider = new LlamaServerProvider({
				baseURL: 'http://localhost:8080',
				model: 'test-model',
				maxRetries: 1,
			});

			const invalidResponse = {
				taskName: 'Bad',
				estimatedMinutes: 'not-a-number',
				category: 'invalid',
				subtasks: 'not-an-array',
			};

			const createMock = vi.fn().mockResolvedValue({
				choices: [{ message: { content: JSON.stringify(invalidResponse) } }],
			});

			overrideClient(provider, createMock);

			await expect(
				provider.complete({
					messages: [{ role: 'user', content: 'Analyze task' }],
					schema: TaskAnalysisSchema,
					schemaName: 'task-analysis',
				}),
			).rejects.toThrow('LLM output failed Zod validation after');

			// maxRetries=1 means 2 total attempts (0 and 1)
			expect(createMock).toHaveBeenCalledTimes(2);
		});

		it('throws after exhausting retries with empty content', async () => {
			const provider = new LlamaServerProvider({
				baseURL: 'http://localhost:8080',
				model: 'test-model',
				maxRetries: 1,
			});

			const createMock = vi.fn().mockResolvedValue({
				choices: [{ message: { content: '' } }],
			});

			overrideClient(provider, createMock);

			await expect(
				provider.complete({
					messages: [{ role: 'user', content: 'Analyze task' }],
					schema: TaskAnalysisSchema,
					schemaName: 'task-analysis',
				}),
			).rejects.toThrow('LLM returned empty content after all retries');
		});

		it('throws friendly "server unreachable" message when network error exhausts retries', async () => {
			const provider = new LlamaServerProvider({
				baseURL: 'http://localhost:8080',
				model: 'test-model',
				maxRetries: 1,
			});

			const connErr = Object.assign(new Error('Connection error.'), {
				name: 'APIConnectionError',
				cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
			});
			const createMock = vi.fn().mockRejectedValue(connErr);

			overrideClient(provider, createMock);

			await expect(
				provider.complete({
					messages: [{ role: 'user', content: 'Analyze task' }],
					schema: TaskAnalysisSchema,
					schemaName: 'task-analysis',
				}),
			).rejects.toThrow(
				'LLM server unreachable at http://localhost:8080. Is llama-server running?',
			);
		});
	});
});

describe('createLlmProvider factory', () => {
	const baseConfig: AppConfig = {
		PORT: 3000,
		LOG_LEVEL: 'info',
		LLAMA_SERVER_URL: 'http://localhost:8080',
		LLAMA_MODEL_NAME: 'test-model',
		LLM_PROVIDER: 'mock',
		LLM_MAX_RETRIES: 2,
	};

	it('creates MockLlmProvider when LLM_PROVIDER=mock', () => {
		const provider = createLlmProvider({ ...baseConfig, LLM_PROVIDER: 'mock' });
		expect(provider).toBeInstanceOf(MockLlmProvider);
	});

	it('creates LlamaServerProvider when LLM_PROVIDER=llama-server', () => {
		const provider = createLlmProvider({
			...baseConfig,
			LLM_PROVIDER: 'llama-server',
		});
		expect(provider).toBeInstanceOf(LlamaServerProvider);
	});
});

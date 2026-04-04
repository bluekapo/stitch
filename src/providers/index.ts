import type { AppConfig } from '../config.js';
import { LlamaServerProvider } from './llama-server.js';
import type { LlmProvider } from './llm.js';
import { MockLlmProvider } from './mock.js';

export function createLlmProvider(config: AppConfig): LlmProvider {
	switch (config.LLM_PROVIDER) {
		case 'llama-server':
			return new LlamaServerProvider({
				baseURL: config.LLAMA_SERVER_URL,
				model: config.LLAMA_MODEL_NAME,
				maxRetries: config.LLM_MAX_RETRIES,
			});
		case 'mock':
			return new MockLlmProvider();
		default:
			throw new Error(`Unknown LLM provider: ${config.LLM_PROVIDER}`);
	}
}

export { LlamaServerProvider } from './llama-server.js';
// Re-export types for convenience
export type { ChatMessage, LlmCompletionOptions, LlmProvider } from './llm.js';
export { MockLlmProvider } from './mock.js';

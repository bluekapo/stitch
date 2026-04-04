import type { z } from 'zod';

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

export interface LlmCompletionOptions<T extends z.ZodType> {
	messages: ChatMessage[];
	schema: T;
	schemaName: string;
	temperature?: number;
	maxTokens?: number;
}

export interface LlmProvider {
	/** Send a chat completion request and return Zod-validated structured output */
	complete<T extends z.ZodType>(options: LlmCompletionOptions<T>): Promise<z.infer<T>>;

	/** Check if the LLM backend is reachable and ready */
	healthCheck(): Promise<{ ok: boolean; error?: string }>;
}

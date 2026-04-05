import OpenAI from 'openai';
import type { z } from 'zod';
import { toResponseFormat } from '../schemas/llm.js';
import type { LlmCompletionOptions, LlmProvider } from './llm.js';

export class LlamaServerProvider implements LlmProvider {
	private client: OpenAI;
	private model: string;
	private maxRetries: number;
	private baseURL: string;

	constructor(config: {
		baseURL: string;
		model: string;
		maxRetries?: number;
	}) {
		// Per D-09: baseURL points to llama-server (default http://localhost:8080)
		// Append /v1 for OpenAI-compatible endpoint
		this.baseURL = config.baseURL;
		this.client = new OpenAI({
			baseURL: `${config.baseURL}/v1`,
			apiKey: 'not-needed', // llama-server doesn't require API key (Pitfall 6)
		});
		this.model = config.model;
		this.maxRetries = config.maxRetries ?? 2; // Per D-17: retry 2-3 times
	}

	async complete<T extends z.ZodType>(options: LlmCompletionOptions<T>): Promise<z.infer<T>> {
		// Per D-15: Belt-and-suspenders -- send JSON Schema via response_format AND validate with Zod
		const responseFormat = toResponseFormat(options.schema, options.schemaName);

		for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
			try {
				const thinking = options.thinking ?? true;
				const body: Record<string, unknown> = {
					model: this.model,
					messages: options.messages,
					temperature: options.temperature ?? 0.7,
					max_tokens: options.maxTokens ?? 1024,
					response_format: responseFormat,
				};
				// llama-server extension: disable thinking at Jinja template level
				if (!thinking) {
					body.chat_template_kwargs = { enable_thinking: false };
				}
				const response = await this.client.chat.completions.create(
					body as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming,
				);

				const content = response.choices[0]?.message?.content;
				if (!content) {
					if (attempt < this.maxRetries) continue;
					throw new Error('LLM returned empty content after all retries');
				}

				// Per D-15: Zod validation as second layer of defense
				const parsed = JSON.parse(content);
				const result = options.schema.safeParse(parsed);

				if (result.success) {
					return result.data;
				}

				// Per D-17: Retry on validation failure (non-deterministic)
				if (attempt < this.maxRetries) {
					continue;
				}

				throw new Error(
					`LLM output failed Zod validation after ${this.maxRetries + 1} attempts: ${JSON.stringify(result.error.issues)}`,
				);
			} catch (err) {
				if (
					attempt < this.maxRetries &&
					!(err instanceof Error && err.message.includes('Zod validation'))
				) {
					continue;
				}
				throw err;
			}
		}

		// Unreachable, but TypeScript needs it
		throw new Error('Exhausted retries');
	}

	async healthCheck(): Promise<{ ok: boolean; error?: string }> {
		try {
			// llama-server exposes GET /health returning {"status":"ok"} (200) or 503 when loading
			const response = await fetch(`${this.baseURL}/health`);
			if (response.ok) {
				return { ok: true };
			}
			const body = await response.json().catch(() => ({}));
			return {
				ok: false,
				error: (body as Record<string, unknown>)?.error?.toString() ?? `HTTP ${response.status}`,
			};
		} catch (err) {
			// Per INFRA-05: clear error when unavailable, do NOT crash
			return {
				ok: false,
				error: err instanceof Error ? err.message : 'Connection failed',
			};
		}
	}
}

import OpenAI from 'openai';
import type { z } from 'zod';
import { toResponseFormat } from '../schemas/llm.js';
import type { LlmCompletionOptions, LlmProvider } from './llm.js';

/** Detect fetch-level connection failures so we can surface a friendlier message. */
function isNetworkError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	if (err.name === 'APIConnectionError' || err.name === 'APIConnectionTimeoutError') return true;
	if (err.message === 'fetch failed') return true;
	const code = (err as { cause?: { code?: string } })?.cause?.code;
	return code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ECONNRESET';
}

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
				// Strip <think>...</think> blocks — Qwen3/3.5 emits these even with
				// enable_thinking:false (empty block) or when the model ignores the flag.
				const cleaned = content.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
				const parsed = JSON.parse(cleaned);
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
				if (isNetworkError(err)) {
					throw new Error(`LLM server unreachable at ${this.baseURL}. Is llama-server running?`, {
						cause: err,
					});
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

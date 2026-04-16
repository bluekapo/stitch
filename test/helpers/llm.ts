import type { z } from 'zod';
import type { LlmCompletionOptions } from '../../src/providers/llm.js';
import { MockLlmProvider } from '../../src/providers/mock.js';

/**
 * Phase 13 Wave 0: Extended mock LLM provider with callback support.
 *
 * Subclass of MockLlmProvider that adds:
 * - setCallback(schemaName, fn): dynamic response generation for prompt inspection tests
 * - Callback wins over fixture when both registered for the same schemaName
 *
 * Also exports `capturingLlm()` helper that records every complete() invocation
 * for assertion in tests.
 */
export class ScriptedMockLlmProvider extends MockLlmProvider {
	private callbacks: Map<string, (opts: LlmCompletionOptions<z.ZodType>) => unknown> = new Map();

	/**
	 * Register a callback for a given schema name. When complete() is called
	 * with a matching schemaName, the callback receives the full options object
	 * (including messages, temperature, thinking, etc.) and its return value
	 * is parsed against options.schema before returning.
	 *
	 * Callbacks take priority over fixtures registered via setFixture().
	 */
	setCallback(schemaName: string, fn: (opts: LlmCompletionOptions<z.ZodType>) => unknown): void {
		this.callbacks.set(schemaName, fn);
	}

	override async complete<T extends z.ZodType>(
		options: LlmCompletionOptions<T>,
	): Promise<z.infer<T>> {
		const callback = this.callbacks.get(options.schemaName);
		if (callback) {
			const raw = await callback(options as LlmCompletionOptions<z.ZodType>);
			const result = options.schema.safeParse(raw);
			if (!result.success) {
				throw new Error(
					`ScriptedMockLlmProvider callback failed Zod validation for "${options.schemaName}": ${JSON.stringify(result.error.issues)}`,
				);
			}
			return result.data;
		}
		// Delegate to parent's fixture-based behavior
		return super.complete(options);
	}
}

/**
 * Convenience factory that creates a ScriptedMockLlmProvider and attaches
 * a recording spy. Every complete() call is logged with the schemaName and
 * messages array for later assertion.
 */
export function capturingLlm(): {
	llm: ScriptedMockLlmProvider;
	calls: Array<{
		schemaName: string;
		messages: unknown[];
		temperature?: number;
		thinking?: boolean;
	}>;
} {
	const llm = new ScriptedMockLlmProvider();
	const calls: Array<{
		schemaName: string;
		messages: unknown[];
		temperature?: number;
		thinking?: boolean;
	}> = [];

	// Wrap complete to record calls before delegating
	const originalComplete = llm.complete.bind(llm);
	llm.complete = async <T extends z.ZodType>(
		options: LlmCompletionOptions<T>,
	): Promise<z.infer<T>> => {
		calls.push({
			schemaName: options.schemaName,
			messages: options.messages,
			temperature: options.temperature,
			thinking: options.thinking,
		});
		return originalComplete(options);
	};

	return { llm, calls };
}

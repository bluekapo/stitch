import type { z } from 'zod';
import type { LlmCompletionOptions, LlmProvider } from './llm.js';

export class MockLlmProvider implements LlmProvider {
	private fixtures: Map<string, unknown> = new Map();

	/** Register a fixture response for a given schema name */
	setFixture(schemaName: string, data: unknown): void {
		this.fixtures.set(schemaName, data);
	}

	async complete<T extends z.ZodType>(options: LlmCompletionOptions<T>): Promise<z.infer<T>> {
		const fixture = this.fixtures.get(options.schemaName);
		if (!fixture) {
			throw new Error(`No mock fixture registered for schema: ${options.schemaName}`);
		}
		const result = options.schema.safeParse(fixture);
		if (!result.success) {
			throw new Error(
				`Mock fixture failed Zod validation for "${options.schemaName}": ${JSON.stringify(result.error.issues)}`,
			);
		}
		return result.data;
	}

	async healthCheck(): Promise<{ ok: boolean; error?: string }> {
		return { ok: true };
	}
}

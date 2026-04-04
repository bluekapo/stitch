import { z } from 'zod';

const envSchema = z.object({
	PORT: z.coerce.number().default(3000),
	LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
	LLAMA_SERVER_URL: z.string().url().default('http://localhost:8080'),
	LLAMA_MODEL_NAME: z.string().default('qwen3.5-9b'),
	LLM_PROVIDER: z.enum(['llama-server', 'mock']).default('mock'),
	LLM_MAX_RETRIES: z.coerce.number().min(0).max(5).default(2),
	WHISPER_SERVER_URL: z.string().url().default('http://localhost:8081'),
	STT_PROVIDER: z.enum(['whisper-server', 'mock']).default('mock'),
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(): AppConfig {
	const result = envSchema.safeParse(process.env);
	if (!result.success) {
		console.error('Invalid environment configuration:', result.error.format());
		process.exit(1);
	}
	return result.data;
}

import { z } from 'zod';

const envSchema = z.object({
	PORT: z.coerce.number().default(3000),
	LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
	LLAMA_SERVER_URL: z.string().url().default('http://localhost:8080'),
	LLAMA_MODEL_NAME: z.string().default('qwen3.5-9b'),
	LLM_PROVIDER: z.enum(['llama-server', 'mock']).default('mock'),
	LLM_MAX_RETRIES: z.coerce.number().min(0).max(5).default(2),
	DATABASE_URL: z.string().default('./data/stitch.db'),
	WHISPER_SERVER_URL: z.string().url().default('http://localhost:8081'),
	STT_PROVIDER: z.enum(['whisper-server', 'mock']).default('mock'),
	TELEGRAM_BOT_TOKEN: z.string().default(''),
	TELEGRAM_ALLOWED_USER_ID: z.coerce.number().optional(),
	RECURRENCE_CRON_TIME: z.string().default('0 5 * * *'),

	// Phase 9: CheckInService cadence
	NUDGE_TICK_INTERVAL_MS: z.coerce.number().int().positive().default(30000),

	// Phase 9: Wake webhook security + idempotency (D-18 required, no default)
	WAKE_SECRET: z
		.string()
		.min(16, 'WAKE_SECRET must be at least 16 characters (Phase 9 webhook security)'),
	WAKE_DEBOUNCE_MS: z.coerce.number().int().positive().default(300000),

	// Phase 9: Check-in message TTL (15 min) — overrides default 60s scheduleCleanup
	CHECKIN_CLEANUP_MS: z.coerce.number().int().positive().default(900000),
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

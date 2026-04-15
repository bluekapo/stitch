import { z } from 'zod';

const envSchema = z.object({
	PORT: z.coerce.number().default(3000),
	// Phase 12 (D-06): default level is `debug` so LLM I/O is visible without
	// re-configuring at run time. Logs rotate per session, so volume is bounded.
	LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('debug'),
	// Phase 12 (D-01/D-05): directory that holds the rotated logs. Tests override
	// to an os.tmpdir() subdir so real data/logs/ is never touched.
	LOG_DIR: z.string().default('./data/logs'),
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
		// D-20 bootstrap exception: the structured logger is not yet constructed
		// (we are validating the env that configures it). Any failure here aborts
		// startup via process.exit(1). This is the ONLY permitted direct stderr
		// call in src/; every other src/ site must route through an injected
		// pino.Logger.
		process.stderr.write(
			`Invalid environment configuration:\n${JSON.stringify(result.error.format(), null, 2)}\n`,
		);
		process.exit(1);
	}
	return result.data;
}

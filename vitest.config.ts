import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globals: true,
		environment: 'node',
		include: ['test/**/*.test.ts'],
		// Phase 12 (D-09): Fastify's onReady hook runs LLM + STT health checks,
		// the restart-safety check-in, and the initial plan generation. Under
		// the default pool (one worker per core) those all run concurrently
		// across ~37 test files, which can spike CPU enough that buildTestApp
		// + app.ready() blows past vitest's 10s default hook budget. 30s gives
		// comfortable headroom without masking real hangs — any genuinely
		// hung hook still surfaces, just later.
		hookTimeout: 30_000,
		coverage: {
			provider: 'v8',
			include: ['src/**/*.ts'],
			exclude: ['src/server.ts'],
		},
	},
});

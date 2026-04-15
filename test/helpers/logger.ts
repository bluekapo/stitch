import pino, { type Logger } from 'pino';

/**
 * Silent logger for tests (Phase 12 D-12).
 *
 * Existing tests that now need to pass a logger (D-12 requires a logger in
 * src/ constructors) import this helper. `{ level: 'silent' }` is pino's
 * standard no-op mode — no transport, no output, no side effects.
 */
export function createTestLogger(): Logger {
	return pino({ level: 'silent' });
}

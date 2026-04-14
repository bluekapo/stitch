import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { WakeStateService } from '../core/wake-state.js';

/**
 * Constant-time secret comparison with length-mismatch guard.
 *
 * Pitfall 6 (09-RESEARCH.md): node:crypto's timingSafeEqual throws RangeError
 * when buffers differ in length. We MUST length-check FIRST and return false
 * on mismatch, not let timingSafeEqual throw — otherwise a wrong-length secret
 * 500s the route, which:
 *   1. Defeats the opaque-404 (D-18) — attackers see 500 on length differences.
 *   2. Pollutes logs with stack traces on every random scan.
 */
function safeCompare(provided: string, expected: string): boolean {
	const a = Buffer.from(provided);
	const b = Buffer.from(expected);
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

/**
 * POST /wake/:secret
 *
 * D-17: Optional JSON body for forward-compat. We accept any body shape — don't
 *       validate, don't reject on extra fields.
 * D-18: Wrong/missing secret returns 404 (opaque, looks like a missing route).
 * D-19: Two-layer idempotency lives in WakeStateService.handleWakeCall().
 *       Route just delegates and forwards the result as JSON.
 * D-20: Day-start sequence side effects fire inside handleWakeCall when status='fired'.
 */
export async function wakeRoutes(fastify: FastifyInstance): Promise<void> {
	fastify.post<{ Params: { secret: string }; Body?: unknown }>(
		'/wake/:secret',
		async (request, reply) => {
			const { secret } = request.params;

			// Read expected secret from app config decorator
			const config = (fastify as unknown as { config: { WAKE_SECRET: string } }).config;
			const expected = config.WAKE_SECRET;

			if (!safeCompare(secret, expected)) {
				// D-18: opaque 404 — looks like a missing route
				return reply.code(404).send({ error: 'Not Found' });
			}

			// Get the WakeStateService from the decorator
			const wakeStateService = (fastify as unknown as { wakeStateService: WakeStateService })
				.wakeStateService;
			if (!wakeStateService) {
				request.log.error('wakeStateService decorator missing');
				return reply.code(500).send({ error: 'Internal Server Error' });
			}

			try {
				const result = await wakeStateService.handleWakeCall();
				return reply.code(200).send(result);
			} catch (err) {
				request.log.error({ err }, 'wake handler crashed');
				return reply.code(500).send({ error: 'Internal Server Error' });
			}
		},
	);
}

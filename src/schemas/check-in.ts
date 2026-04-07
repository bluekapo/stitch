import { z } from 'zod';

/**
 * Phase 9 — LLM oracle response schemas for the CheckInService.
 *
 * Two schemas for two LLM calls:
 *
 * 1. CheckInResponseSchema — the per-tick oracle that decides whether to
 *    speak, what to say, and when to check in again. The router enforces at
 *    runtime that `message` is non-null when `should_speak === true` (D-09).
 *
 * 2. BufferEndDispositionSchema — the batched buffer-end disposition oracle
 *    that decides what to do with each task in an expiring chunk (D-08).
 *
 * Decision references:
 * - D-09: should_speak default false, silence by default — being forced does
 *   not force speech
 * - D-15: oracle output shape {should_speak, message, next_check_minutes,
 *   reasoning?}
 * - D-08: batched buffer-end disposition LLM call returns one decision per task
 * - D-03: 30 minutes is a sensible default cadence; min(1) sanity guard only
 * - D-10: trigger reason union has 6 literals (lives in src/types/check-in.ts)
 *
 * RESEARCH Pitfall 8 mitigation: belt-and-suspenders. The provider validates
 * via response_format (JSON Schema produced by z.toJSONSchema) AND Zod
 * safeParse. The smoke tests in test/schemas/check-in.test.ts assert that the
 * draft-07 JSON Schema shape is what llama.cpp expects.
 */

export const CheckInResponseSchema = z.object({
	should_speak: z
		.boolean()
		.describe(
			'True only when there is something meaningful to say. Default false. Silence is the default — being forced does not force speech (D-09).',
		),
	message: z
		.string()
		.nullable()
		.describe(
			'2-4 sentences in JARVIS voice. Null when should_speak is false. Required when should_speak is true (router enforces this at runtime).',
		),
	next_check_minutes: z
		.number()
		.int()
		.min(1)
		.max(360)
		.describe('Minutes until the next scheduled check-in. 30 is a sensible default per D-03.'),
	reasoning: z
		.string()
		.optional()
		.describe('Optional reasoning for debug logs only — not shown to user.'),
});

export type CheckInResponse = z.infer<typeof CheckInResponseSchema>;

export const BufferEndDispositionSchema = z.object({
	decisions: z
		.array(
			z.object({
				taskId: z
					.number()
					.int()
					.describe(
						'id from the chunk task list — never invented. Hallucination defense lives in the consumer (CheckInService.runBufferEndDisposition).',
					),
				action: z
					.enum(['continue', 'postpone', 'skip', 'move_to_next_chunk'])
					.describe(
						'continue=leave attached, postpone=push back to pool with postpone_count++, skip=mark skipped, move_to_next_chunk=reattach to next chunk in plan',
					),
			}),
		)
		.describe(
			'One decision per task in the expiring chunk. Empty array allowed when chunk has no tasks.',
		),
});

export type BufferEndDisposition = z.infer<typeof BufferEndDispositionSchema>;

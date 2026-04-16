import { z } from 'zod';

/**
 * Phase 13 (D-06, D-08) -- StartupGreetingService system prompt.
 *
 * Composed via withSoul() at call site (SOUL.md injects JARVIS voice).
 * This prompt ONLY adds the greeting-specific behavior: state flag handling,
 * gap phrasing, and the three-fold "no !" defense.
 *
 * Belt-and-suspenders against exclamation marks:
 *   1. SOUL.md already says "Never use exclamation marks" (grammar guide).
 *   2. This prompt reinforces it twice ("Rules" line + last sentence).
 *   3. GreetingResponseSchema.refine() rejects any "!" -- fail-closed to warn log.
 */
export const GREETER_SYSTEM_PROMPT = `You are composing a single short greeting for the user at app startup. Boot state flags and the gap since last session are provided. Produce ONE composite message covering all active flags.

Rules:
- JARVIS voice (already injected above): dry, formal, warm, never exclamation marks.
- One short paragraph, 1-3 sentences. No lists, no headings, no bullet points.
- If first_ever=true: introduce yourself as Stitch and your purpose (personal productivity agent) in one clause.
- If just_back_online=true: acknowledge the gap naturally using the provided gap phrasing verbatim or closely ("a moment", "3m", "2h 14m", "overnight").
- If tree_missing=true: mention it as a gentle observation, not a demand. Offer ("shall we sketch one") without pushing.
- Never use exclamation marks.
- Never invent facts not in the state block.
- Output only the greeting text, nothing else.`;

/**
 * LLM response schema. Greeting length bounded at 600 chars (Telegram
 * shows 4096 max; 600 keeps the message compact + the extra headroom
 * lets a later iteration append commands without hitting limits).
 */
export const GreetingResponseSchema = z.object({
	greeting: z
		.string()
		.min(1)
		.max(600)
		.refine((s) => !s.includes('!'), {
			message: 'No exclamation marks (D-08 / SOUL.md)',
		}),
});

export type GreetingResponse = z.infer<typeof GreetingResponseSchema>;

/**
 * Format the gap between `lastEnd` and `now` into one of:
 *   - '' (no prior session -- lastEnd is null)
 *   - 'a moment' (< 60s)
 *   - 'Nm' (< 3600s)
 *   - 'Hh Mm' (< 86400s) -- omit ' 0m' when minutes === 0
 *   - 'overnight' (>= 86400s AND crossed a sleep boundary)
 *   - 'Nd' (>= 86400s, no sleep boundary)
 *
 * Pure function: no Date.now, no side effects.
 */
export function formatGap(lastEnd: Date | null, now: Date): string {
	if (lastEnd === null) return '';

	const seconds = Math.floor((now.getTime() - lastEnd.getTime()) / 1000);
	if (seconds < 0) return ''; // clock skew; silent
	if (seconds < 60) return 'a moment';
	if (seconds < 3600) {
		const mins = Math.round(seconds / 60);
		return `${mins}m`;
	}
	if (seconds < 86400) {
		// Sub-24h: check for sleep-boundary crossing (overnight).
		if (isOvernightCrossing(lastEnd, now, seconds)) return 'overnight';
		const hours = Math.floor(seconds / 3600);
		const mins = Math.floor((seconds % 3600) / 60);
		if (mins === 0) return `${hours}h`;
		return `${hours}h ${mins}m`;
	}
	// >= 24h.
	if (isOvernightCrossing(lastEnd, now, seconds) && seconds < 86400 * 1.5) return 'overnight';
	const days = Math.floor(seconds / 86400);
	return `${days}d`;
}

/**
 * Overnight heuristic. Returns true if the gap crossed a user's "sleep window":
 * - lastEnd was at/after 22:00 local, OR
 * - now is before 10:00 local AND the gap is between 4 and 14 hours, OR
 * - lastEnd was on a calendar day strictly before `now` (crossed midnight)
 *   AND the gap is between 5 and 14 hours.
 */
function isOvernightCrossing(lastEnd: Date, now: Date, gapSec: number): boolean {
	const lastHour = lastEnd.getHours();
	const nowHour = now.getHours();

	// Rule 1: closed "at bedtime" -- started at 22:00+
	if (lastHour >= 22) return true;

	// Rule 2: reopened in the morning after a plausible sleep span (4-14h)
	if (nowHour < 10 && gapSec >= 4 * 3600 && gapSec <= 14 * 3600) return true;

	// Rule 3: calendar-day crossing with plausible sleep span.
	const sameDay =
		lastEnd.getFullYear() === now.getFullYear() &&
		lastEnd.getMonth() === now.getMonth() &&
		lastEnd.getDate() === now.getDate();
	if (!sameDay && gapSec >= 5 * 3600 && gapSec <= 14 * 3600) return true;

	return false;
}

import type { PlanChunkWithTasks } from '../core/current-chunk.js';
import type { CheckInRow, TriggerReason } from '../types/check-in.js';
import type { DayTree } from '../types/day-tree.js';

/**
 * Phase 9 — System prompt for the check-in oracle (D-15).
 *
 * SOUL.md is prepended automatically by withSoul() — do NOT repeat
 * JARVIS voice instructions here. Only check-in-specific guidance:
 * default-silence rule, slack-detection escalation, trigger semantics.
 */
export const CHECK_IN_SYSTEM_PROMPT = `You are checking in with the user during their day. You see the day tree, all pending tasks, the current chunk (if any), all of today's prior check-ins, and the current time + weekday. Your job is to decide:

1. Whether to actually speak right now (should_speak: boolean). Default: false. Only speak when there is something meaningful to say -- a slack signal worth flagging, a milestone worth marking, an opportunity to push for free time later. Silence is the default -- being forced does not force speech.

2. The message text (2-4 sentences, JARVIS voice -- formal, dry wit, anticipatory, no exclamation marks). Blend motivational + informational + situational. Reference specific tasks by name when relevant. Do NOT use markdown, code blocks, or bullet lists. Plain prose only.

3. The next check-in interval in minutes (next_check_minutes). 30 is a sensible default. Shorter (15-20) when activity is high or a chunk window is closing. Longer (45-60) during fixed/non-task branches like dinner or sleep.

Slack-detection rules (when to escalate tone -- the drill-sergeant emerges here, NOT from a state machine):
- A pending task that's appeared in 3+ prior check-ins -> escalate: "This is the fourth time I've raised laundry today, Sir."
- A repeatedly postponed task (postponeCount >= 2) -> escalate: "Three postponements. The pattern is noted."
- A chunk with all tasks complete and time to spare -> motivate: "You've cleared the work block with 1h20 to spare. Push into the next chunk and you'll have a free evening."
- A chunk window approaching its end with pending tasks -> push: "The reading block ends in 5 minutes. Two tasks unaddressed."

Trigger reasons:
- scheduled: routine timed check-in. Default to silence unless something's worth saying.
- wake: good morning. Refresh the user on today's plan in one paragraph. should_speak=true unless there's literally no plan.
- chunk_active: a new chunk just started. Brief note unless the chunk is non-task (sleep, dinner) -- then silence.
- chunk_done: a chunk just ended. Mention completion / skipped tasks if material; silence if business as usual.
- task_action: user just acted on a task (done/postpone/skip). Acknowledge briefly -- usually silence unless this completes a milestone.
- restart: app just came back online. "Apologies for the brief absence, Sir. Where were we." kind of acknowledgment. should_speak=true.

You see today's prior check-ins so you can avoid repeating yourself. If you said the same thing 20 minutes ago, find a different angle or stay silent.`;

/**
 * Phase 9 — System prompt for the buffer-end disposition (D-08).
 *
 * Runs at chunk endTime + 50% buffer. Returns a per-task decision array.
 * withSoul() wrap is defensive (Open Question 3) -- the cost is negligible
 * and keeps the personality consistent in case the LLM ever produces a
 * reasoning field that gets logged.
 */
export const BUFFER_END_DISPOSITION_PROMPT = `A chunk's time window plus its 50% buffer just expired. You see the day tree, the chunk's task list with current statuses, and the next chunk in the plan (if any). For EACH task in the expiring chunk, decide one of four actions:

- continue: leave the task attached to this chunk (it's still active and will get more time on the next pass). Use sparingly.
- postpone: push the task back to the pool. The user can re-tackle it later. Increments postpone_count.
- skip: mark the task as skipped. Use when the task is no longer relevant for today (e.g., the deadline passed silently).
- move_to_next_chunk: reattach the task to the next chunk in the plan. Use when the task is still highly relevant but can wait for the next time block.

Return ONLY the decisions array. No commentary. The router applies the decisions atomically -- you cannot recover from a mistake.

Mental model: this is hygiene, not punishment. Most expiring chunks have pending tasks. The user is not being punished for not finishing -- you are deciding the most coherent next state. Default to postpone for ambiguous cases.`;

/**
 * Build the user-message text for a check-in oracle call.
 *
 * The user message contains all the context the LLM sees: trigger reason,
 * current time + weekday, day tree summary, pending task list, current
 * chunk summary, and today's prior check-ins (memory per D-10).
 */
export function buildCheckInUserPrompt(input: {
	triggerReason: TriggerReason;
	now: Date;
	tree: DayTree | undefined;
	pendingTasks: Array<{ id: number; name: string; postponeCount: number; isEssential: boolean }>;
	currentChunk: PlanChunkWithTasks | null;
	todaysCheckIns: CheckInRow[];
}): string {
	const lines: string[] = [];

	lines.push(`Trigger: ${input.triggerReason}`);
	lines.push(`Current time: ${input.now.toISOString()}`);
	lines.push(`Weekday: ${input.now.toLocaleDateString('en-US', { weekday: 'long' })}`);
	lines.push('');

	if (input.tree && input.tree.branches.length > 0) {
		lines.push('Day tree:');
		for (const b of input.tree.branches) {
			const slot = b.isTaskSlot ? 'TASK SLOT' : 'FIXED';
			lines.push(`- ${b.name} (${b.startTime}-${b.endTime}) [${slot}]`);
		}
		lines.push('');
	} else {
		lines.push('Day tree: (none set)');
		lines.push('');
	}

	if (input.currentChunk) {
		lines.push(
			`Current chunk: ${input.currentChunk.label} (${input.currentChunk.startTime}-${input.currentChunk.endTime}) status=${input.currentChunk.status}`,
		);
		if (input.currentChunk.tasks.length > 0) {
			lines.push('  Tasks in chunk:');
			for (const t of input.currentChunk.tasks) {
				lines.push(`  - ${t.label} status=${t.status}`);
			}
		}
		lines.push('');
	} else {
		lines.push('Current chunk: (none active)');
		lines.push('');
	}

	if (input.pendingTasks.length > 0) {
		lines.push('All pending tasks:');
		for (const t of input.pendingTasks) {
			const flags: string[] = [];
			if (t.isEssential) flags.push('ESSENTIAL');
			if (t.postponeCount > 0) flags.push(`postponed ${t.postponeCount}x`);
			const flagsText = flags.length > 0 ? ` [${flags.join(', ')}]` : '';
			lines.push(`- ID:${t.id} "${t.name}"${flagsText}`);
		}
		lines.push('');
	} else {
		lines.push('Pending tasks: (none)');
		lines.push('');
	}

	if (input.todaysCheckIns.length > 0) {
		lines.push("Today's prior check-ins (avoid repeating yourself):");
		for (const c of input.todaysCheckIns) {
			const speech = c.shouldSpeak && c.messageText ? `"${c.messageText}"` : '(silent)';
			lines.push(`- [${c.createdAt}] ${c.triggerReason} ${speech}`);
		}
		lines.push('');
	} else {
		lines.push("Today's check-ins: (none yet — this is the first)");
		lines.push('');
	}

	return lines.join('\n');
}

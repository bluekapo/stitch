import type { Logger } from 'pino';
import { withSoul } from '../prompts/soul.js';
import type { LlmProvider } from '../providers/llm.js';
import { type ClassifiedIntent, ClassifierResponseSchema } from '../schemas/intent.js';
import { getCurrentChunk } from './current-chunk.js';
import type { DailyPlanService } from './daily-plan-service.js';
import type { DayTreeService } from './day-tree-service.js';
import type { TaskService } from './task-service.js';

/**
 * Phase 08.4 D-22 -- confidence threshold for clarification.
 * Constant in service code per CONTEXT D-22 (NOT a config value).
 * Router compares classified.confidence against this and replies with
 * classified.clarification when below.
 */
export const CONFIDENCE_THRESHOLD = 0.7;

// Few-shot examples cross-reference (Pitfall 7 mitigation):
// Schema fields used in prompt examples MUST match src/schemas/intent.ts:
//   task_create:      intent, confidence, suggested_chunk_id, suggested_branch_name, is_essential
//   task_modify:      intent, confidence, task_id, action in {done, postpone, delete, start_timer, stop_timer}
//   tree_edit:        intent, confidence, modification
//   plan_regenerate:  intent, confidence, target_date
//   task_query:       intent, confidence, scope? (all|current_chunk)
//   plan_view:        intent, confidence, target_date? (today|tomorrow)
//   tree_query/unknown: intent, confidence, clarification?
//   tree_setup:       intent, confidence (NEW -- Phase 13 D-09)
//   tree_confirm:     intent, confidence (NEW -- Phase 13 D-10)
//   compound:         intent, confidence, steps[] (NEW -- Phase 13 D-20, flat only)
const CLASSIFIER_SYSTEM_PROMPT = `You classify the user's message into ONE of 10 intents and extract the relevant fields. One of those intents (compound) wraps multiple other intents as a sequential step list.

Intents:
- task_create: user wants to create a new task
- task_modify: user wants to mark a task done, postpone it, delete it, start its timer, or stop its timer
- task_query: user wants to see their tasks
- tree_edit: user wants to modify an EXISTING day tree (time periods)
- tree_query: user wants to see the day tree
- tree_setup: user wants to BUILD or REBUILD their day tree through conversation (especially when Day tree is currently <not set>)
- tree_confirm: user is confirming a tree proposal from the assistant's most recent turn in Recent conversation turns
- plan_regenerate: user wants to regenerate today's or tomorrow's plan
- plan_view: user wants to see today's plan
- compound: user's single message requests 2+ distinct actions -- wrap them in steps[] (min 2, NEVER nested)
- unknown: cannot determine intent or message is unrelated chitchat

Disambiguation rules (D-15 + Phase 13 additions):
- Time ranges like HH-HH, HH:MM-HH:MM, 15-16, 8-10am usually signal tree_edit.
- Words like "block", "slot", "period", "routine", "branch", "cycle" signal tree.
- Plain action verbs without time ranges (buy, call, clean) signal task_create.
- Explicit token "task" in input forces task_create -- "add dinner task" is a task even if "dinner" is a tree branch.
- Past-tense verbs on task list members ("I finished X", "done with X") signal task_modify with action: "done".
- Words like "push", "postpone", "delay" on task list members signal task_modify with action: "postpone".

- tree_setup vs tree_edit: if Day tree is "<not set>", or user says "build", "create", "from scratch", "sketch a tree", "new tree" -> tree_setup. If Day tree exists AND user describes a concrete modification to existing structure -> tree_edit.
- tree_confirm: fire ONLY when Recent conversation turns shows the assistant just proposed a tree (wrapper_text announcing a commit or "shall I commit") AND the user's latest message is a short affirmation ("yes", "commit it", "go ahead", "looks good, commit"). Without that context, an ambiguous "yes" -> unknown.
- compound: fire ONLY when the message contains 2+ clearly distinct action verbs from different intents (e.g., "add X and mark Y done", "show my plan then regenerate it"). Do NOT use compound for a single intent with multiple objects ("add X and Y" is ONE task_create, not compound). NEVER nest compound inside steps[].

For task_create:
- Set suggested_chunk_id and suggested_branch_name from the current chunk (provided in context) if one is active and the user did NOT specify a different time. Otherwise null.
- Set is_essential=true ONLY if user explicitly says "must do", "essential", "locked", or "critical".

For task_modify:
- task_id: pick from the pending task list by name match. NEVER invent an id.
- action:
  * "done" -- user says "finished", "done with", "I did X", "completed"
  * "postpone" -- user says "push", "postpone", "delay", "later"
  * "delete" -- user says "delete", "remove", "throw away", "scrap", "cancel"
  * "start_timer" -- user says "start X", "start the X timer", "begin X", "track X"
  * "stop_timer" -- user says "stop X", "stop the X timer", "end X"

For task_query:
- scope: default omitted (= all pending). Set scope="current_chunk" when the user asks about the current chunk explicitly.

For plan_view:
- target_date: "today" is the default (omit). Use "tomorrow" only if the user explicitly says "tomorrow's plan".

For tree_edit:
- modification: CLEANED phrase, NOT raw user text. Example: "yo move dinner to like 20:00 thx" -> "move dinner to 20:00".

For plan_regenerate:
- target_date: "today" by default. Use "tomorrow" only if the user explicitly says "tomorrow".

For tree_setup and tree_confirm:
- No extra payload fields. Just intent + confidence (+ clarification if confidence < 0.7).

For compound:
- steps: array of 2+ classified intents (same shape as single-intent responses but without the compound option). NEVER include a compound intent inside steps. If the user's message would require nested compound, flatten it -- pick the most clearly stated 2-3 actions and drop the rest into a clarification.

Confidence: 0.0-1.0. If confidence < 0.7, set clarification to a JARVIS-voice question (formal but warm, dry wit, anticipatory). Example: "Apologies, Sir. Was that a new task or an edit to the day tree?"

Few-shot examples (D-16 + Phase 13):
1. Input: "add groceries"
   Output: { "intent": "task_create", "confidence": 0.95, "suggested_chunk_id": <current or null>, "suggested_branch_name": <current or null>, "is_essential": false }
2. Input: "add a reading block from 15-16"
   Output: { "intent": "tree_edit", "confidence": 0.95, "modification": "add a reading block from 15:00 to 16:00" }
3. Input: "move dinner to 20:00"
   Output: { "intent": "tree_edit", "confidence": 0.95, "modification": "move dinner to 20:00" }
4. Input: "I finished laundry"
   Output: { "intent": "task_modify", "confidence": 0.9, "task_id": <id of laundry from pending list>, "action": "done" }
5. Input: "what's my plan today"
   Output: { "intent": "plan_view", "confidence": 0.95 }
6. Input: "regenerate my plan"
   Output: { "intent": "plan_regenerate", "confidence": 0.95, "target_date": "today" }
7. Input: "show me my day tree"
   Output: { "intent": "tree_query", "confidence": 0.95 }
8. Input: "add dinner task"
   Output: { "intent": "task_create", "confidence": 0.9, "suggested_chunk_id": <current or null>, "suggested_branch_name": <current or null>, "is_essential": false }
9. Input: "delete groceries"
   Output: { "intent": "task_modify", "confidence": 0.9, "task_id": <id from pending list>, "action": "delete" }
10. Input: "start the groceries timer"
    Output: { "intent": "task_modify", "confidence": 0.9, "task_id": <id from pending list>, "action": "start_timer" }
11. Input: "show me my current chunk tasks"
    Output: { "intent": "task_query", "confidence": 0.9, "scope": "current_chunk" }
12. Input: "let's build a day tree" (Day tree context: <not set>)
    Output: { "intent": "tree_setup", "confidence": 0.95 }
13. Input: "yes commit it" (Recent conversation turns ends with: "Stitch: Shall I commit that, Sir?")
    Output: { "intent": "tree_confirm", "confidence": 0.95 }
14. Input: "add groceries and mark laundry done"
    Output: { "intent": "compound", "confidence": 0.9, "steps": [
      { "intent": "task_create", "confidence": 0.9, "suggested_chunk_id": null, "suggested_branch_name": null, "is_essential": false },
      { "intent": "task_modify", "confidence": 0.9, "task_id": <id of laundry>, "action": "done" }
    ] }`;

export class IntentClassifierService {
	// D-12: `logger` REQUIRED and placed AHEAD of the optional dailyPlanService.
	// Contract is "logger-first among required deps, optional deps last" so the
	// fail-closed DI rule isn't silently downgraded by argument order.
	constructor(
		private llmProvider: LlmProvider,
		private dayTreeService: DayTreeService,
		private taskService: TaskService,
		private logger: Logger,
		private dailyPlanService?: DailyPlanService,
	) {}

	async classify(
		userInput: string,
		reqLogger?: Logger,
		recent_turns?: string[],
	): Promise<ClassifiedIntent> {
		const log = reqLogger ?? this.logger;
		log.debug({ userInput, recentTurnsLen: recent_turns?.length ?? 0 }, 'intent.classify:start');

		const tree = this.dayTreeService.getTree();
		const allTasks = this.taskService.list();
		const pending = allTasks
			.filter((t) => t.status === 'pending' || t.status === 'active')
			.map((t) => `  ID:${t.id} "${t.name}" status:${t.status}`)
			.join('\n');

		const plan = this.dailyPlanService?.getTodayPlan();
		const chunks =
			plan && this.dailyPlanService ? this.dailyPlanService.getPlanWithChunks(plan.id).chunks : [];
		const now = new Date();
		const current = getCurrentChunk(chunks, now);

		const hh = String(now.getHours()).padStart(2, '0');
		const mm = String(now.getMinutes()).padStart(2, '0');
		const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][now.getDay()];

		// Phase 13 D-10: recent_turns only emitted into prompt when non-empty.
		// Empty array or undefined -> omit the block entirely so tree_confirm's
		// "require recent assistant tree-setup turn" rule naturally fails.
		const recentTurnsBlock =
			recent_turns && recent_turns.length > 0
				? `Recent conversation turns (oldest first):\n${recent_turns.join('\n')}`
				: null;

		const userPromptParts = [
			`Day tree: ${tree ? JSON.stringify(tree) : '<not set>'}`,
			`Pending tasks:\n${pending || '  <none>'}`,
			current
				? `Current chunk: ID:${current.id}, branch="${current.branchName}", time=${current.startTime}-${current.endTime}, label="${current.label}"`
				: `Current chunk: <none>`,
			`Current time: ${hh}:${mm}, weekday: ${weekday}`,
		];
		if (recentTurnsBlock) userPromptParts.push(recentTurnsBlock);
		userPromptParts.push(`User message: ${userInput}`);

		const userPrompt = userPromptParts.join('\n\n');

		// D-11: belt-and-suspenders (response_format + Zod safeParse via provider),
		// withSoul wrap, temperature 0.3, thinking: false.
		const result = await this.llmProvider.complete({
			messages: [
				{ role: 'system', content: withSoul(CLASSIFIER_SYSTEM_PROMPT) },
				{ role: 'user', content: userPrompt },
			],
			schema: ClassifierResponseSchema,
			schemaName: 'intent_classifier',
			temperature: 0.3,
			maxTokens: 512,
			thinking: false,
		});
		log.debug({ intent: result.intent, confidence: result.confidence }, 'intent.classify:done');
		return result;
	}
}

import { withSoul } from '../prompts/soul.js';
import type { LlmProvider } from '../providers/llm.js';
import { type ClassifiedIntent, ClassifierResponseSchema } from '../schemas/intent.js';
import { getCurrentChunk } from './current-chunk.js';
import type { DailyPlanService } from './daily-plan-service.js';
import type { DayTreeService } from './day-tree-service.js';
import type { TaskService } from './task-service.js';

/**
 * Phase 08.4 D-22 — confidence threshold for clarification.
 * Constant in service code per CONTEXT D-22 (NOT a config value).
 * Router compares classified.confidence against this and replies with
 * classified.clarification when below.
 */
export const CONFIDENCE_THRESHOLD = 0.7;

// Few-shot examples cross-reference (Pitfall 7 mitigation):
// Schema fields used in prompt examples MUST match src/schemas/intent.ts:
//   task_create:      intent, confidence, suggested_chunk_id, suggested_branch_name, is_essential
//   task_modify:      intent, confidence, task_id, action
//   tree_edit:        intent, confidence, modification
//   plan_regenerate:  intent, confidence, target_date
//   task_query/tree_query/plan_view/unknown: intent, confidence, clarification?
const CLASSIFIER_SYSTEM_PROMPT = `You classify the user's message into ONE of 8 intents and extract the relevant fields.

Intents:
- task_create: user wants to create a new task
- task_modify: user wants to mark a task done or postpone it
- task_query: user wants to see their tasks
- tree_edit: user wants to modify the day tree (time periods)
- tree_query: user wants to see the day tree
- plan_regenerate: user wants to regenerate today's or tomorrow's plan
- plan_view: user wants to see today's plan
- unknown: cannot determine intent or message is unrelated chitchat

Disambiguation rules (D-15):
- Time ranges like HH-HH, HH:MM-HH:MM, 15-16, 8-10am usually signal tree_edit.
- Words like "block", "slot", "period", "routine", "branch", "cycle" signal tree.
- Plain action verbs without time ranges (buy, call, clean) signal task_create.
- Explicit token "task" in input forces task_create — "add dinner task" is a task even if "dinner" is a tree branch.
- Past-tense verbs on task list members ("I finished X", "done with X") signal task_modify with action: "done".
- Words like "push", "postpone", "delay" on task list members signal task_modify with action: "postpone".

For task_create:
- Set suggested_chunk_id and suggested_branch_name from the current chunk (provided in context) if one is active and the user did NOT specify a different time. Otherwise null.
- Set is_essential=true ONLY if user explicitly says "must do", "essential", "locked", or "critical".

For task_modify:
- task_id: pick from the pending task list by name match. NEVER invent an id.
- action: "done" for completion, "postpone" for delay.

For tree_edit:
- modification: write a CLEANED phrase, NOT the raw user text. Example: user says "yo move dinner to like 20:00 thx" — return modification: "move dinner to 20:00".

For plan_regenerate:
- target_date: "today" by default. Use "tomorrow" only if the user explicitly says "tomorrow".

Confidence: 0.0-1.0. If confidence < 0.7, set clarification to a JARVIS-voice question (formal but warm, dry wit, anticipatory). Example: "Apologies, Sir. Was that a new task or an edit to the day tree?"

If the user describes more than one action in a single message (Pitfall 2), pick the most clearly stated one and return its intent. Do not attempt to handle multiple actions in one classification.

Few-shot examples (D-16):
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
   Output: { "intent": "task_create", "confidence": 0.9, "suggested_chunk_id": <current or null>, "suggested_branch_name": <current or null>, "is_essential": false }`;

export class IntentClassifierService {
	constructor(
		private llmProvider: LlmProvider,
		private dayTreeService: DayTreeService,
		private taskService: TaskService,
		private dailyPlanService?: DailyPlanService,
	) {}

	async classify(userInput: string): Promise<ClassifiedIntent> {
		// D-12: load all context internally — caller passes only raw text.
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

		const userPrompt = [
			`Day tree: ${tree ? JSON.stringify(tree) : '<not set>'}`,
			`Pending tasks:\n${pending || '  <none>'}`,
			current
				? `Current chunk: ID:${current.id}, branch="${current.branchName}", time=${current.startTime}-${current.endTime}, label="${current.label}"`
				: `Current chunk: <none>`,
			`Current time: ${hh}:${mm}, weekday: ${weekday}`,
			`User message: ${userInput}`,
		].join('\n\n');

		// D-11: belt-and-suspenders (response_format + Zod safeParse via provider),
		// withSoul wrap, temperature 0.3, thinking: false.
		return this.llmProvider.complete({
			messages: [
				{ role: 'system', content: withSoul(CLASSIFIER_SYSTEM_PROMPT) },
				{ role: 'user', content: userPrompt },
			],
			schema: ClassifierResponseSchema,
			schemaName: 'intent_classifier',
			temperature: 0.3,
			maxTokens: 256,
			thinking: false,
		});
	}
}

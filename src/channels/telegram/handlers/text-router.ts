import { addDays, format } from 'date-fns';
import { desc, eq } from 'drizzle-orm';
import type { CheckInService } from '../../../core/check-in-service.js';
import { resolveCurrentChunkAttachment } from '../../../core/current-chunk.js';
import type { DailyPlanService } from '../../../core/daily-plan-service.js';
import type { DayTreeService } from '../../../core/day-tree-service.js';
import {
	CONFIDENCE_THRESHOLD,
	type IntentClassifierService,
} from '../../../core/intent-classifier.js';
import type { TaskParserService } from '../../../core/task-parser.js';
import type { TaskService } from '../../../core/task-service.js';
import type { StitchDb } from '../../../db/index.js';
import { chunkTasks } from '../../../db/schema.js';
import { buildFullDayPlanView } from '../view-builders.js';
import {
	formatCompletionWithDiff,
	formatDuration,
	renderDayPlanView,
	renderTaskListText,
	renderTreeView,
} from '../views.js';

export interface TextRouterDeps {
	taskService: TaskService;
	parser: TaskParserService;
	dayTreeService?: DayTreeService;
	dailyPlanService?: DailyPlanService;
	intentClassifierService?: IntentClassifierService;
	// Phase 9 (D-05.4): fire forced check-in after task mutations. Optional
	// + catch-and-discard pattern so task actions never fail if the
	// check-in service is missing or throws.
	checkInService?: CheckInService;
	// Phase 10 (D-18): DB access for reading chunk_tasks prediction columns
	// at task completion time. Optional for backward compat with existing tests.
	db?: StitchDb;
}

// Phase 10 (D-18): read the most recent chunk_tasks row for a task to
// get its prediction columns. Used for the completion diff line.
export function readPredictionFromDb(db: StitchDb | undefined, taskId: number): {
	predictedMaxSeconds: number | null;
	predictedConfidence: 'low' | 'medium' | 'high' | null;
} {
	if (!db) return { predictedMaxSeconds: null, predictedConfidence: null };
	const row = db
		.select({
			max: chunkTasks.predictedMaxSeconds,
			confidence: chunkTasks.predictedConfidence,
		})
		.from(chunkTasks)
		.where(eq(chunkTasks.taskId, taskId))
		.orderBy(desc(chunkTasks.id))
		.limit(1)
		.get();
	if (!row) return { predictedMaxSeconds: null, predictedConfidence: null };
	return {
		predictedMaxSeconds: row.max ?? null,
		predictedConfidence: (row.confidence ?? null) as 'low' | 'medium' | 'high' | null,
	};
}

/**
 * Route text input through explicit fast-paths or LLM classifier dispatch.
 *
 * Order of precedence (D-20 — explicit syntax wins):
 *   1. Slash commands → skip (handled by grammY command handlers)
 *   2. ID-based fast-paths (delete N, start N, stop N, done N, postpone N)
 *   3. Tree prefix block (tree show, tree edit X, tree X)
 *   4. Classifier dispatch (everything else, including bare "list", "add foo")
 *
 * The classifier dispatch was introduced in Phase 08.4 to replace the
 * "anything unrecognized is a task" NL fallback. Voice/text "Change dinner to
 * 20:00" now routes to DayTreeService.editTree() instead of being mis-parsed
 * into a task name.
 */
export async function routeTextInput(
	text: string,
	deps: TextRouterDeps,
): Promise<{ reply: string }> {
	const { taskService, parser } = deps;

	// Skip slash commands
	if (text.startsWith('/')) return { reply: '' };

	try {
		// --- Explicit ID-based fast-paths (D-20) ---

		// delete <id>
		const deleteMatch = text.match(/^delete (\d+)$/i);
		if (deleteMatch) {
			const id = Number(deleteMatch[1]);
			const task = taskService.getById(id);
			if (!task) return { reply: 'Task not found.' };
			taskService.delete(id);
			return { reply: `Deleted: ${task.name} (#${task.id})` };
		}

		// start <id>
		const startMatch = text.match(/^start (\d+)$/i);
		if (startMatch) {
			const id = Number(startMatch[1]);
			const task = taskService.getById(id);
			if (!task) return { reply: 'Task not found.' };
			taskService.startTimer(id);
			return { reply: `Timer started: ${task.name} (#${task.id})` };
		}

		// stop <id>
		const stopMatch = text.match(/^stop (\d+)$/i);
		if (stopMatch) {
			const id = Number(stopMatch[1]);
			const task = taskService.getById(id);
			if (!task) return { reply: 'Task not found.' };
			const durationSeconds = taskService.stopTimer(id);
			return {
				reply: `Timer stopped: ${task.name} (#${task.id}) -- ${formatDuration(durationSeconds)}`,
			};
		}

		// done <id>
		const doneMatch = text.match(/^done (\d+)$/i);
		if (doneMatch) {
			const id = Number(doneMatch[1]);
			const task = taskService.getById(id);
			if (!task) return { reply: 'Task not found.' };

			const hadTimer = !!task.timerStartedAt;
			const pred = readPredictionFromDb(deps.db, id);

			let actualSeconds = 0;
			if (hadTimer) {
				actualSeconds = taskService.stopTimer(id);
			}
			taskService.update(id, { status: 'completed' });
			deps.checkInService?.forceCheckIn('task_action').catch(() => {}); // D-05.4

			const reply = hadTimer
				? formatCompletionWithDiff(task.name, task.id, actualSeconds, pred.predictedMaxSeconds, pred.predictedConfidence)
				: `Done: ${task.name} (#${task.id})`;
			return { reply };
		}

		// postpone <id>
		const postponeMatch = text.match(/^postpone (\d+)$/i);
		if (postponeMatch) {
			const id = Number(postponeMatch[1]);
			taskService.postpone(id);
			deps.checkInService?.forceCheckIn('task_action').catch(() => {}); // D-05.4
			const updated = taskService.getById(id);
			return {
				reply: `Postponed: ${updated!.name} (#${id}) -- ${updated!.postponeCount} times total`,
			};
		}

		// --- Tree commands (D-20 — explicit `tree` prefix wins over classifier) ---
		if (deps.dayTreeService) {
			// tree show (most specific -- check first)
			if (/^tree show$/i.test(text)) {
				const tree = deps.dayTreeService.getTree();
				if (!tree) return { reply: 'No day tree set. Use "tree <description>" to create one.' };
				return { reply: renderTreeView(tree) };
			}

			// tree edit <modification> (check before catch-all "tree <description>")
			const editMatch = text.match(/^tree edit (.+)$/is);
			if (editMatch) {
				const tree = await deps.dayTreeService.editTree(editMatch[1].trim());
				return { reply: `Day tree updated.\n\n${renderTreeView(tree)}` };
			}

			// tree <description> (catch-all for tree prefix)
			const treeMatch = text.match(/^tree (.+)$/is);
			if (treeMatch) {
				const tree = await deps.dayTreeService.setTree(treeMatch[1].trim());
				return { reply: `Day tree created.\n\n${renderTreeView(tree)}` };
			}
		}

		// --- Classifier dispatch (D-01, Phase 08.4) ---
		if (!deps.intentClassifierService) {
			// Backward-compat for tests that don't wire the classifier.
			// Production wiring is in src/app.ts and src/channels/telegram/index.ts;
			// any production code path reaching here without a classifier is a
			// configuration bug, not a normal flow.
			return { reply: 'Error: classifier not configured.' };
		}

		let classified;
		try {
			classified = await deps.intentClassifierService.classify(text);
		} catch (err) {
			// D-35: fail-closed. NO fallback to silent task creation.
			// D-37: log the failure (Pino via Fastify is wired at the app level;
			// here we use console.error to keep the router free of logger DI).
			console.error('intent classifier failed:', {
				input: text.slice(0, 100),
				error: (err as Error).message,
			});
			return {
				reply:
					'Classification failed. Please try again or use an explicit command: `add <name>`, `tree edit <change>`, `list`.',
			};
		}

		// D-22: confidence threshold + D-25: unknown intent handling.
		// Both produce a JARVIS-voice clarification (D-23) — the classifier
		// supplies the clarification text in the schema; if missing, fall back
		// to a generic JARVIS-voice apology (D-24 — stateless, no DB write).
		if (classified.confidence < CONFIDENCE_THRESHOLD || classified.intent === 'unknown') {
			return {
				reply: classified.clarification ?? 'Apologies, Sir. Could you rephrase that?',
			};
		}

		switch (classified.intent) {
			case 'task_create': {
				// Two-call architecture (D-09): classifier identified the intent,
				// now Call-2 = TaskParserService extracts the structured fields
				// (name, deadline, taskType, recurrenceDay) from the original text.
				const parsed = await parser.parse(text);
				const recurrenceDay = parsed.taskType === 'weekly' ? parsed.recurrenceDay : undefined;

				// D-26: chunk attachment. Prefer the classifier's suggestion. If
				// the classifier returned null (e.g., "buy milk on saturday" — no
				// current chunk applicable), fall back to the D-16 current-chunk
				// resolver. If both yield null, the task is unattached (chunkId=null).
				let chunkId: number | null = classified.suggested_chunk_id;
				let branchName: string | null = classified.suggested_branch_name;
				if (chunkId === null) {
					const fallback = resolveCurrentChunkAttachment(deps.dailyPlanService);
					chunkId = fallback.chunkId;
					branchName = fallback.branchName;
				}

				const task = taskService.create({
					name: parsed.name,
					description: parsed.description,
					// Either signal wins on essential — classifier's is_essential
					// catches phrases like "I MUST do X today"; parser's isEssential
					// catches add!-style explicit markers via NL.
					isEssential: parsed.isEssential || classified.is_essential,
					taskType: parsed.taskType,
					deadline: parsed.deadline,
					recurrenceDay,
					chunkId,
					branchName,
				});
				deps.checkInService?.forceCheckIn('task_action').catch(() => {}); // D-05.4

				let reply = classified.is_essential
					? `Essential task created: ${task.name} (#${task.id})`
					: `Task created: ${task.name} (#${task.id})`;
				if (parsed.taskType !== 'ad-hoc') reply += `\nType: ${parsed.taskType}`;
				if (parsed.deadline) reply += `\nDeadline: ${parsed.deadline}`;
				if (recurrenceDay !== undefined) reply += `\nRecurs: day ${recurrenceDay}`;
				if (branchName) reply += `\nAttached: ${branchName}`;
				return { reply };
			}

			case 'task_modify': {
				const target = taskService.getById(classified.task_id);
				if (!target) return { reply: `Task #${classified.task_id} not found.` };
				if (classified.action === 'done') {
					const hadTimer = !!target.timerStartedAt;
					const pred = readPredictionFromDb(deps.db, target.id);

					let actualSeconds = 0;
					if (hadTimer) {
						actualSeconds = taskService.stopTimer(target.id);
					}
					taskService.update(target.id, { status: 'completed' });
					deps.checkInService?.forceCheckIn('task_action').catch(() => {}); // D-05.4

					const reply = hadTimer
						? formatCompletionWithDiff(target.name, target.id, actualSeconds, pred.predictedMaxSeconds, pred.predictedConfidence)
						: `Done: ${target.name} (#${target.id})`;
					return { reply };
				}
				if (classified.action === 'postpone') {
					taskService.postpone(target.id);
					deps.checkInService?.forceCheckIn('task_action').catch(() => {}); // D-05.4
					const updated = taskService.getById(target.id)!;
					return {
						reply: `Postponed: ${updated.name} (#${updated.id}) -- ${updated.postponeCount} times total`,
					};
				}
				return { reply: 'Unsupported action.' };
			}

			case 'task_query':
				return { reply: renderTaskListText(taskService.list()) };

			case 'tree_edit': {
				if (!deps.dayTreeService) return { reply: 'Day tree service not configured.' };
				const tree = await deps.dayTreeService.editTree(classified.modification);
				return { reply: `Day tree updated.\n\n${renderTreeView(tree)}` };
			}

			case 'tree_query': {
				if (!deps.dayTreeService) return { reply: 'Day tree service not configured.' };
				const tree = deps.dayTreeService.getTree();
				if (!tree)
					return {
						reply: 'No day tree set, Sir. Use `tree <description>` to create one.',
					};
				return { reply: renderTreeView(tree) };
			}

			case 'plan_regenerate': {
				if (!deps.dailyPlanService) return { reply: 'Plan service not configured.' };
				// D-31: target_date is 'today' or 'tomorrow' from the classifier.
				const date =
					classified.target_date === 'tomorrow'
						? format(addDays(new Date(), 1), 'yyyy-MM-dd')
						: format(new Date(), 'yyyy-MM-dd');
				try {
					const result = await deps.dailyPlanService.generatePlan(date);
					const when = classified.target_date === 'tomorrow' ? 'for tomorrow' : 'for today';
					return { reply: `Plan ${when} regenerated. ${result.chunks.length} chunks.` };
				} catch (err) {
					// D-33: friendly error if no day tree exists.
					const msg = (err as Error).message;
					if (msg.includes('No day tree')) {
						return {
							reply: 'No day tree set, Sir. Use `tree <description>` to create one first.',
						};
					}
					return { reply: `Error: ${msg}` };
				}
			}

			case 'plan_view': {
				if (!deps.dailyPlanService) return { reply: 'Plan service not configured.' };
				const view = buildFullDayPlanView(deps.dailyPlanService);
				return { reply: renderDayPlanView(view, 'full') };
			}
		}
	} catch (err) {
		// D-36: downstream service errors (editTree throws, generatePlan throws,
		// taskService.create throws) bubble up here and produce a contextual
		// error reply. The classifier-level catch above is more specific and
		// handles classifier failures separately so D-35 fail-closed semantics
		// are preserved.
		return { reply: `Error: ${(err as Error).message}` };
	}
}

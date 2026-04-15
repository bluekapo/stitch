import { addDays, format } from 'date-fns';
import { desc, eq } from 'drizzle-orm';
import pino, { type Logger } from 'pino';
import type { CheckInService } from '../../../core/check-in-service.js';
import { resolveCurrentChunkAttachment } from '../../../core/current-chunk.js';
import type { DailyPlanService } from '../../../core/daily-plan-service.js';
import type { DayTreeService } from '../../../core/day-tree-service.js';
import {
	CONFIDENCE_THRESHOLD,
	type IntentClassifierService,
} from '../../../core/intent-classifier.js';
import { reqId } from '../../../core/logger.js';
import type { TaskParserService } from '../../../core/task-parser.js';
import type { TaskService } from '../../../core/task-service.js';
import type { StitchDb } from '../../../db/index.js';
import { chunkTasks } from '../../../db/schema.js';
import type { ClassifiedIntent } from '../../../schemas/intent.js';
import { buildFullDayPlanView } from '../view-builders.js';
import {
	escapeHtml,
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
	// Phase 12 (D-11, D-20): pino logger for structured request logs. Optional
	// for backward compat with existing tests — production wiring ALWAYS passes
	// the root or a tagged child logger. When absent, the router falls back to
	// a silent pino so `log.error(...)` calls remain valid no-ops.
	logger?: Logger;
}

// Phase 12 (D-11): silent fallback so the router never crashes on a missing
// logger in legacy test wiring. Production call sites in src/channels/telegram/
// always pass a real tagged logger.
const silentLogger: Logger = pino({ level: 'silent' });

// Phase 10 (D-18): read the most recent chunk_tasks row for a task to
// get its prediction columns. Used for the completion diff line.
export function readPredictionFromDb(
	db: StitchDb | undefined,
	taskId: number,
): {
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
 * Phase 12 (D-13): LLM-only input surface. ALL text (except slash commands)
 * is classified by the LLM. Regex fast-paths were removed in 12-04 per D-13
 * (single input surface) and D-19 (fail-closed — no regex resurrection on
 * classifier failure).
 *
 * Order of precedence:
 *   1. Slash commands → skip (handled by grammY command handlers)
 *   2. Classifier dispatch for everything else
 *
 * On classifier failure: reply with a JARVIS-voice "Classification failed"
 * message directing the user to the hub buttons. NO fallback to regex
 * extraction, NO silent task creation. See D-19.
 *
 * Per-interaction `reqLogger` (3rd arg) is created by the caller at the text
 * or voice entry point so one request_id ties together the text-handler log
 * line, the classifier log line, and the service mutation log line (D-11).
 * When omitted, this function creates its own reqLogger from `deps.logger`.
 */
export async function routeTextInput(
	text: string,
	deps: TextRouterDeps,
	reqLogger?: Logger,
): Promise<{ reply: string }> {
	const { taskService, parser } = deps;

	// Skip slash commands
	if (text.startsWith('/')) return { reply: '' };

	// D-11: request-scoped child logger. Callers that already hold a reqLogger
	// pass it through; otherwise we synthesize one here so every mutating
	// service call gets a correlation id for the log line.
	const baseLogger = deps.logger ?? silentLogger;
	const log = reqLogger ?? baseLogger.child({ req_id: reqId() });
	log.debug({ input: text.slice(0, 80) }, 'routeTextInput:start');

	try {
		// --- Classifier dispatch (D-13: single input surface, fail-closed per D-19) ---
		if (!deps.intentClassifierService) {
			// Backward-compat for tests that don't wire the classifier.
			// Production wiring is in src/app.ts and src/channels/telegram/index.ts;
			// any production code path reaching here without a classifier is a
			// configuration bug, not a normal flow.
			return { reply: 'Error: classifier not configured.' };
		}

		let classified: ClassifiedIntent;
		try {
			classified = await deps.intentClassifierService.classify(text, log);
		} catch (err) {
			// D-19: fail-closed. NO regex resurrection — the regex block was
			// deleted in 12-04. The user is directed to the hub buttons which
			// have no classifier dependency.
			// D-20: structured logging via reqLogger — no console sink.
			log.error(
				{ input: text.slice(0, 100), err: (err as Error).message },
				'intent classifier failed',
			);
			return {
				reply: 'Classification failed. Please try again or use the hub buttons.',
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

				const task = taskService.create(
					{
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
					},
					log,
				);
				deps.checkInService?.forceCheckIn('task_action').catch(() => {}); // D-17

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

				switch (classified.action) {
					case 'done': {
						const hadTimer = !!target.timerStartedAt;
						const pred = readPredictionFromDb(deps.db, target.id);
						let actualSeconds = 0;
						if (hadTimer) {
							actualSeconds = taskService.stopTimer(target.id, log);
						}
						taskService.update(target.id, { status: 'completed' }, log);
						deps.checkInService?.forceCheckIn('task_action').catch(() => {}); // D-17
						return {
							reply: hadTimer
								? formatCompletionWithDiff(
										target.name,
										target.id,
										actualSeconds,
										pred.predictedMaxSeconds,
										pred.predictedConfidence,
									)
								: `Done: ${target.name} (#${target.id})`,
						};
					}

					case 'postpone': {
						taskService.postpone(target.id, log);
						deps.checkInService?.forceCheckIn('task_action').catch(() => {}); // D-17
						const updated = taskService.getById(target.id);
						if (!updated) {
							throw new Error(
								`text-router: expected task #${target.id} to exist after postpone() succeeded — getById returned undefined`,
							);
						}
						return {
							reply: `Postponed: ${updated.name} (#${updated.id}) -- ${updated.postponeCount} times total`,
						};
					}

					case 'delete': {
						const name = target.name;
						taskService.delete(target.id, log);
						deps.checkInService?.forceCheckIn('task_action').catch(() => {}); // D-17
						return { reply: `Deleted: ${name} (#${classified.task_id})` };
					}

					case 'start_timer': {
						taskService.startTimer(target.id, log);
						deps.checkInService?.forceCheckIn('task_action').catch(() => {}); // D-17
						return { reply: `Timer started: ${target.name} (#${target.id})` };
					}

					case 'stop_timer': {
						// TaskService throws 'No timer running on this task.' if none.
						// D-36 outer catch converts to JARVIS reply (D-15 state-mismatch contract).
						const durationSeconds = taskService.stopTimer(target.id, log);
						deps.checkInService?.forceCheckIn('task_action').catch(() => {}); // D-17
						return {
							reply: `Timer stopped: ${target.name} (#${target.id}) -- ${formatDuration(durationSeconds)}`,
						};
					}
				}
				// TypeScript exhaustive: classified.action is the 5-value union.
				return { reply: 'Unsupported action.' };
			}

			case 'task_query': {
				// D-16: scope='current_chunk' narrows the view to the active chunk.
				if (classified.scope === 'current_chunk') {
					const attach = resolveCurrentChunkAttachment(deps.dailyPlanService);
					if (attach.chunkId == null) {
						return {
							reply: `No current chunk active, Sir. Showing all pending tasks.\n\n${renderTaskListText(taskService.list())}`,
						};
					}
					return { reply: renderTaskListText(taskService.listForChunk(attach.chunkId)) };
				}
				return { reply: renderTaskListText(taskService.list()) };
			}

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
						reply:
							'No day tree set, Sir. Tree creation will become conversational in the next update.',
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
					const result = await deps.dailyPlanService.generatePlan(date, log);
					const when = classified.target_date === 'tomorrow' ? 'for tomorrow' : 'for today';
					return { reply: `Plan ${when} regenerated. ${result.chunks.length} chunks.` };
				} catch (err) {
					// D-33: friendly error if no day tree exists.
					const msg = (err as Error).message;
					if (msg.includes('No day tree')) {
						return {
							reply:
								'No day tree set, Sir. Tree creation will become conversational in the next update.',
						};
					}
					return { reply: `Error: ${escapeHtml(msg)}` };
				}
			}

			case 'plan_view': {
				if (!deps.dailyPlanService) return { reply: 'Plan service not configured.' };
				// D-16: target_date='tomorrow' renders the plan for tomorrow if one
				// exists. buildFullDayPlanView is today-scoped by default, so we read
				// the tomorrow plan via getPlan(date) and pass it explicitly.
				if (classified.target_date === 'tomorrow') {
					const tomorrowDate = format(addDays(new Date(), 1), 'yyyy-MM-dd');
					const plan = deps.dailyPlanService.getPlan?.(tomorrowDate);
					if (!plan) return { reply: 'No plan for tomorrow yet, Sir.' };
					const view = buildFullDayPlanView(deps.dailyPlanService, {
						id: plan.id,
						date: plan.date,
					});
					return { reply: renderDayPlanView(view, 'full') };
				}
				const view = buildFullDayPlanView(deps.dailyPlanService);
				return { reply: renderDayPlanView(view, 'full') };
			}
		}
	} catch (err) {
		// D-36: downstream service errors (editTree throws, generatePlan throws,
		// taskService.create throws) bubble up here and produce a contextual
		// error reply. The classifier-level catch above is more specific and
		// handles classifier failures separately so D-19 fail-closed semantics
		// are preserved.
		return { reply: `Error: ${escapeHtml((err as Error).message)}` };
	}
}

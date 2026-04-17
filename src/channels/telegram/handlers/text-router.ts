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
import type { TreeSetupService } from '../../../core/tree-setup-service.js';
import type { StitchDb } from '../../../db/index.js';
import { chunkTasks, conversations } from '../../../db/schema.js';
import type { ClassifiedIntent, StepIntent } from '../../../schemas/intent.js';
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
	// for backward compat with existing tests -- production wiring ALWAYS passes
	// the root or a tagged child logger. When absent, the router falls back to
	// a silent pino so `log.error(...)` calls remain valid no-ops.
	logger?: Logger;
	// Phase 13 (D-11): TreeSetupService for conversational tree creation.
	// Optional for backward compat with pre-Phase-13 tests.
	treeSetupService?: TreeSetupService;
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

// Fetch the last N conversation turns (oldest first), formatted as
// "role: content" lines for the classifier's recent_turns prompt slot.
// Without this, mid-tree-setup pivots like "yes flexible" get misclassified
// as tree_confirm because the LLM has zero context about the ongoing iteration.
export function readRecentTurns(db: StitchDb | undefined, limit: number): string[] {
	if (!db) return [];
	const rows = db
		.select({ role: conversations.role, content: conversations.content })
		.from(conversations)
		.orderBy(desc(conversations.id))
		.limit(limit)
		.all();
	return rows.reverse().map((r) => `${r.role}: ${r.content}`);
}

// ==========================================================
// StepResult + per-intent dispatch functions (Phase 13 refactor)
// ==========================================================

type StepResult = { reply: string; wasMutation: boolean };

/**
 * Which intents count as "task_action" for forceCheckIn purposes.
 * - task_create / task_modify / plan_regenerate: yes (user just did something that affects plan state).
 * - tree_edit / tree_setup / tree_confirm: no (structural changes; the next check-in tick picks them up).
 * - queries: no (read-only).
 */
function isTaskActionIntent(intent: StepIntent['intent']): boolean {
	return intent === 'task_create' || intent === 'task_modify' || intent === 'plan_regenerate';
}

async function dispatchTaskCreate(
	classified: Extract<StepIntent, { intent: 'task_create' }>,
	text: string,
	deps: TextRouterDeps,
	log: Logger,
): Promise<StepResult> {
	const { taskService, parser } = deps;
	const parsed = await parser.parse(text);
	const recurrenceDay = parsed.taskType === 'weekly' ? parsed.recurrenceDay : undefined;

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
			isEssential: parsed.isEssential || classified.is_essential,
			taskType: parsed.taskType,
			deadline: parsed.deadline,
			recurrenceDay,
			chunkId,
			branchName,
		},
		log,
	);

	let reply = classified.is_essential
		? `Essential task created: ${task.name} (#${task.id})`
		: `Task created: ${task.name} (#${task.id})`;
	if (parsed.taskType !== 'ad-hoc') reply += `\nType: ${parsed.taskType}`;
	if (parsed.deadline) reply += `\nDeadline: ${parsed.deadline}`;
	if (recurrenceDay !== undefined) reply += `\nRecurs: day ${recurrenceDay}`;
	if (branchName) reply += `\nAttached: ${branchName}`;

	return { reply, wasMutation: true };
}

async function dispatchTaskModify(
	classified: Extract<StepIntent, { intent: 'task_modify' }>,
	deps: TextRouterDeps,
	log: Logger,
): Promise<StepResult> {
	const { taskService } = deps;
	const target = taskService.getById(classified.task_id);
	if (!target) {
		throw new Error(`Task #${classified.task_id} not found.`);
	}

	switch (classified.action) {
		case 'done': {
			const hadTimer = !!target.timerStartedAt;
			const pred = readPredictionFromDb(deps.db, target.id);
			let actualSeconds = 0;
			if (hadTimer) actualSeconds = taskService.stopTimer(target.id, log);
			taskService.update(target.id, { status: 'completed' }, log);
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
				wasMutation: true,
			};
		}
		case 'postpone': {
			taskService.postpone(target.id, log);
			const updated = taskService.getById(target.id);
			if (!updated) {
				throw new Error(
					`text-router: expected task #${target.id} after postpone -- getById returned undefined`,
				);
			}
			return {
				reply: `Postponed: ${updated.name} (#${updated.id}) -- ${updated.postponeCount} times total`,
				wasMutation: true,
			};
		}
		case 'delete': {
			const name = target.name;
			taskService.delete(target.id, log);
			return {
				reply: `Deleted: ${name} (#${classified.task_id})`,
				wasMutation: true,
			};
		}
		case 'start_timer': {
			taskService.startTimer(target.id, log);
			return { reply: `Timer started: ${target.name} (#${target.id})`, wasMutation: true };
		}
		case 'stop_timer': {
			const durationSeconds = taskService.stopTimer(target.id, log);
			return {
				reply: `Timer stopped: ${target.name} (#${target.id}) -- ${formatDuration(durationSeconds)}`,
				wasMutation: true,
			};
		}
	}
	return { reply: 'Unsupported action.', wasMutation: false };
}

async function dispatchTaskQuery(
	classified: Extract<StepIntent, { intent: 'task_query' }>,
	deps: TextRouterDeps,
	_log: Logger,
): Promise<StepResult> {
	const { taskService } = deps;
	if (classified.scope === 'current_chunk') {
		const attach = resolveCurrentChunkAttachment(deps.dailyPlanService);
		if (attach.chunkId == null) {
			return {
				reply: `No current chunk active, Sir. Showing all pending tasks.\n\n${renderTaskListText(taskService.list())}`,
				wasMutation: false,
			};
		}
		return {
			reply: renderTaskListText(taskService.listForChunk(attach.chunkId)),
			wasMutation: false,
		};
	}
	return { reply: renderTaskListText(taskService.list()), wasMutation: false };
}

async function dispatchTreeEdit(
	classified: Extract<StepIntent, { intent: 'tree_edit' }>,
	deps: TextRouterDeps,
	log: Logger,
): Promise<StepResult> {
	if (!deps.dayTreeService)
		return { reply: 'Day tree service not configured.', wasMutation: false };
	const tree = await deps.dayTreeService.editTree(classified.modification, log);
	return { reply: `Day tree updated.\n\n${renderTreeView(tree)}`, wasMutation: true };
}

async function dispatchTreeQuery(
	_classified: Extract<StepIntent, { intent: 'tree_query' }>,
	deps: TextRouterDeps,
	_log: Logger,
): Promise<StepResult> {
	if (!deps.dayTreeService)
		return { reply: 'Day tree service not configured.', wasMutation: false };
	const tree = deps.dayTreeService.getTree();
	if (!tree) {
		return {
			reply: 'No day tree set, Sir. Say "build a day tree" to start the conversational setup.',
			wasMutation: false,
		};
	}
	return { reply: renderTreeView(tree), wasMutation: false };
}

// Phase 13 (D-11): tree_setup -- conversational tree creation via TreeSetupService.
async function dispatchTreeSetup(
	_classified: Extract<StepIntent, { intent: 'tree_setup' }>,
	userText: string,
	deps: TextRouterDeps,
	log: Logger,
): Promise<StepResult> {
	if (!deps.treeSetupService)
		return { reply: 'Tree setup service not configured.', wasMutation: false };
	const { wrapper_text, committed } = await deps.treeSetupService.propose(userText, log);
	// Tree setup is NOT a task_action -- never trigger forceCheckIn.
	// wasMutation=committed is semantic but forceCheckIn only fires on isTaskActionIntent intents.
	// Escape LLM-generated wrapper_text -- index.ts sends with parse_mode:HTML and the LLM
	// can emit `<`/`>`/`&` that break Telegram's parser (lessons.md 2026-04-14).
	return { reply: escapeHtml(wrapper_text), wasMutation: committed };
}

// Phase 13 (D-10): tree_confirm -- user confirming a committed tree.
// In this release, propose_tree auto-commits (D-12 -- no confirm button),
// so tree_confirm arriving here means "yes" after the commit already landed.
async function dispatchTreeConfirm(
	_classified: Extract<StepIntent, { intent: 'tree_confirm' }>,
	deps: TextRouterDeps,
	_log: Logger,
): Promise<StepResult> {
	if (!deps.dayTreeService)
		return { reply: 'Day tree service not configured.', wasMutation: false };
	const tree = deps.dayTreeService.getTree();

	const replyText = tree
		? `Noted, Sir. The tree is already committed:\n\n${renderTreeView(tree)}`
		: 'Apologies, Sir -- I have nothing to confirm. Say "build a day tree" to start.';

	// Write a conversations row with triggered_by='tree_confirm_reply' via
	// TreeSetupService so the router does not need direct db access for
	// tree-related conversation writes.
	if (deps.treeSetupService) {
		deps.treeSetupService.writeConfirmReply(replyText);
	}

	return { reply: replyText, wasMutation: false };
}

async function dispatchPlanRegenerate(
	classified: Extract<StepIntent, { intent: 'plan_regenerate' }>,
	deps: TextRouterDeps,
	log: Logger,
): Promise<StepResult> {
	if (!deps.dailyPlanService) return { reply: 'Plan service not configured.', wasMutation: false };
	const date =
		classified.target_date === 'tomorrow'
			? format(addDays(new Date(), 1), 'yyyy-MM-dd')
			: format(new Date(), 'yyyy-MM-dd');
	try {
		const result = await deps.dailyPlanService.generatePlan(date, log);
		const when = classified.target_date === 'tomorrow' ? 'for tomorrow' : 'for today';
		return {
			reply: `Plan ${when} regenerated. ${result.chunks.length} chunks.`,
			wasMutation: true,
		};
	} catch (err) {
		const msg = (err as Error).message;
		if (msg.includes('No day tree')) {
			return {
				reply: 'No day tree set, Sir. Say "build a day tree" to start the conversational setup.',
				wasMutation: false,
			};
		}
		return { reply: `Error: ${escapeHtml(msg)}`, wasMutation: false };
	}
}

async function dispatchPlanView(
	classified: Extract<StepIntent, { intent: 'plan_view' }>,
	deps: TextRouterDeps,
	_log: Logger,
): Promise<StepResult> {
	if (!deps.dailyPlanService) return { reply: 'Plan service not configured.', wasMutation: false };
	if (classified.target_date === 'tomorrow') {
		const tomorrowDate = format(addDays(new Date(), 1), 'yyyy-MM-dd');
		const plan = deps.dailyPlanService.getPlan?.(tomorrowDate);
		if (!plan) return { reply: 'No plan for tomorrow yet, Sir.', wasMutation: false };
		const view = buildFullDayPlanView(deps.dailyPlanService, {
			id: plan.id,
			date: plan.date,
		});
		return { reply: renderDayPlanView(view, 'full'), wasMutation: false };
	}
	const view = buildFullDayPlanView(deps.dailyPlanService);
	return { reply: renderDayPlanView(view, 'full'), wasMutation: false };
}

async function dispatchStep(
	classified: StepIntent,
	userText: string,
	deps: TextRouterDeps,
	log: Logger,
): Promise<StepResult> {
	switch (classified.intent) {
		case 'task_create':
			return dispatchTaskCreate(classified, userText, deps, log);
		case 'task_modify':
			return dispatchTaskModify(classified, deps, log);
		case 'task_query':
			return dispatchTaskQuery(classified, deps, log);
		case 'tree_edit':
			return dispatchTreeEdit(classified, deps, log);
		case 'tree_query':
			return dispatchTreeQuery(classified, deps, log);
		case 'tree_setup':
			return dispatchTreeSetup(classified, userText, deps, log);
		case 'tree_confirm':
			return dispatchTreeConfirm(classified, deps, log);
		case 'plan_regenerate':
			return dispatchPlanRegenerate(classified, deps, log);
		case 'plan_view':
			return dispatchPlanView(classified, deps, log);
	}
	// TypeScript exhaustive -- 'unknown' is handled by QueryViewBranch which
	// shares the enum with task_query/tree_query/plan_view. The discriminated
	// union means we never reach here, but the return keeps TSC happy.
	throw new Error(`dispatchStep: unhandled intent ${(classified as { intent: string }).intent}`);
}

// ==========================================================
// Main entry point
// ==========================================================

/**
 * Phase 12 (D-13): LLM-only input surface. ALL text (except slash commands)
 * is classified by the LLM. Regex fast-paths were removed in 12-04 per D-13
 * (single input surface) and D-19 (fail-closed -- no regex resurrection on
 * classifier failure).
 *
 * Phase 13 refactor: per-intent handlers extracted into named dispatchXxx
 * functions returning StepResult. Compound intent loops dispatchStep with
 * continue-on-error + bulleted reply. forceCheckIn moved out of individual
 * handlers into the single-intent default branch and compound caller.
 */
export async function routeTextInput(
	text: string,
	deps: TextRouterDeps,
	reqLogger?: Logger,
): Promise<{ reply: string }> {
	// Skip slash commands
	if (text.startsWith('/')) return { reply: '' };

	// D-11: request-scoped child logger.
	const baseLogger = deps.logger ?? silentLogger;
	const log = reqLogger ?? baseLogger.child({ req_id: reqId() });
	log.debug({ input: text.slice(0, 80) }, 'routeTextInput:start');

	try {
		// --- Classifier dispatch (D-13: single input surface, fail-closed per D-19) ---
		if (!deps.intentClassifierService) {
			return { reply: 'Error: classifier not configured.' };
		}

		let classified: ClassifiedIntent;
		try {
			const recentTurns = readRecentTurns(deps.db, 6);
			classified = await deps.intentClassifierService.classify(text, log, recentTurns);
		} catch (err) {
			log.error(
				{ input: text.slice(0, 100), err: (err as Error).message },
				'intent classifier failed',
			);
			return {
				reply: 'Classification failed. Please try again or use the hub buttons.',
			};
		}

		// D-22: confidence threshold + D-25: unknown intent handling.
		if (classified.confidence < CONFIDENCE_THRESHOLD || classified.intent === 'unknown') {
			return {
				reply: classified.clarification ?? 'Apologies, Sir. Could you rephrase that?',
			};
		}

		// Phase 13 (D-20): compound intent routing.
		if (classified.intent === 'compound') {
			// D-21: sequential continue-on-error.
			// D-22: bulleted reply with "Handled, Sir:" prefix.
			// D-24: single-fire forceCheckIn after all steps.
			const bullets: string[] = [];
			let anyMutation = false;
			for (const step of classified.steps) {
				try {
					const stepResult = await dispatchStep(step, text, deps, log);
					const firstLine = stepResult.reply.split('\n')[0];
					bullets.push(`\u2022 ${firstLine}`);
					if (stepResult.wasMutation && isTaskActionIntent(step.intent)) anyMutation = true;
				} catch (err) {
					const msg = (err as Error).message;
					bullets.push(`\u2022 Error: ${escapeHtml(msg)}`);
					log.warn({ stepIntent: step.intent, err }, 'compound.step-failed');
				}
			}
			if (anyMutation) {
				// D-24: fires ONCE, regardless of how many mutation steps succeeded.
				deps.checkInService?.forceCheckIn('task_action').catch(() => {});
			}
			return { reply: `Handled, Sir:\n${bullets.join('\n')}` };
		}

		// Single-intent dispatch (default path).
		const result = await dispatchStep(classified, text, deps, log);

		// D-17 / Phase 13: forceCheckIn lives here now (moved out of individual case bodies).
		// Only fires for task_action-shaped intents.
		if (result.wasMutation && isTaskActionIntent(classified.intent)) {
			deps.checkInService?.forceCheckIn('task_action').catch(() => {});
		}

		return { reply: result.reply };
	} catch (err) {
		// D-36: downstream service errors bubble up here and produce a contextual
		// error reply.
		return { reply: `Error: ${escapeHtml((err as Error).message)}` };
	}
}

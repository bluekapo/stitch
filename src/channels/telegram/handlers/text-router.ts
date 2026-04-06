import { resolveCurrentChunkAttachment } from '../../../core/current-chunk.js';
import type { DailyPlanService } from '../../../core/daily-plan-service.js';
import type { DayTreeService } from '../../../core/day-tree-service.js';
import type { TaskParserService } from '../../../core/task-parser.js';
import type { TaskService } from '../../../core/task-service.js';
import { createTaskSchema } from '../../../types/task.js';
import { renderTaskListText, formatDuration, renderTreeView } from '../views.js';

export interface TextRouterDeps {
	taskService: TaskService;
	parser: TaskParserService;
	dayTreeService?: DayTreeService;
	dailyPlanService?: DailyPlanService;
}

/**
 * Route text input through command patterns or NL parsing.
 * Shared by both voice handler and (potentially) text handlers.
 * Returns { reply: string } with the response text, or empty string for no-action.
 */
export async function routeTextInput(
	text: string,
	deps: TextRouterDeps,
): Promise<{ reply: string }> {
	const { taskService, parser } = deps;

	// Skip slash commands
	if (text.startsWith('/')) return { reply: '' };

	try {
		// add! <name> (essential task) -- must check before add
		const addEssentialMatch = text.match(/^add! (.+)$/i);
		if (addEssentialMatch) {
			const rawName = addEssentialMatch[1].trim();
			const parsed = createTaskSchema.safeParse({ name: rawName, isEssential: true });
			if (!parsed.success) return { reply: 'Task name must be 1-200 characters.' };
			const attachment = resolveCurrentChunkAttachment(deps.dailyPlanService);
			const task = taskService.create({ ...parsed.data, ...attachment });
			return { reply: `Essential task created: ${task.name} (#${task.id})` };
		}

		// add <name>
		const addMatch = text.match(/^add (.+)$/i);
		if (addMatch) {
			const rawName = addMatch[1].trim();
			const parsed = createTaskSchema.safeParse({ name: rawName });
			if (!parsed.success) return { reply: 'Task name must be 1-200 characters.' };
			const attachment = resolveCurrentChunkAttachment(deps.dailyPlanService);
			const task = taskService.create({ ...parsed.data, ...attachment });
			return { reply: `Task created: ${task.name} (#${task.id})` };
		}

		// list
		if (/^list$/i.test(text)) {
			const allTasks = taskService.list();
			return { reply: renderTaskListText(allTasks) };
		}

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
			return { reply: `Timer stopped: ${task.name} (#${task.id}) -- ${formatDuration(durationSeconds)}` };
		}

		// done <id>
		const doneMatch = text.match(/^done (\d+)$/i);
		if (doneMatch) {
			const id = Number(doneMatch[1]);
			const task = taskService.getById(id);
			if (!task) return { reply: 'Task not found.' };
			if (task.timerStartedAt) taskService.stopTimer(id);
			taskService.update(id, { status: 'completed' });
			return { reply: `Done: ${task.name} (#${task.id})` };
		}

		// postpone <id>
		const postponeMatch = text.match(/^postpone (\d+)$/i);
		if (postponeMatch) {
			const id = Number(postponeMatch[1]);
			taskService.postpone(id);
			const updated = taskService.getById(id);
			return { reply: `Postponed: ${updated!.name} (#${id}) -- ${updated!.postponeCount} times total` };
		}

		// --- Tree commands (per D-08, D-09) ---
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

		// NL fallback: parse via LLM
		const parsed = await parser.parse(text);
		const recurrenceDay = parsed.taskType === 'weekly' ? parsed.recurrenceDay : undefined;
		const attachment = resolveCurrentChunkAttachment(deps.dailyPlanService);
		const task = taskService.create({
			name: parsed.name,
			description: parsed.description,
			isEssential: parsed.isEssential,
			taskType: parsed.taskType,
			deadline: parsed.deadline,
			recurrenceDay,
			...attachment,
		});
		let reply = `Task created: ${task.name} (#${task.id})`;
		if (parsed.taskType !== 'ad-hoc') reply += `\nType: ${parsed.taskType}`;
		if (parsed.deadline) reply += `\nDeadline: ${parsed.deadline}`;
		if (recurrenceDay !== undefined) reply += `\nRecurs: day ${recurrenceDay}`;
		return { reply };
	} catch (err) {
		return { reply: `Error: ${(err as Error).message}` };
	}
}

import { Menu } from '@grammyjs/menu';
import type { CheckInService } from '../../../core/check-in-service.js';
import type { DailyPlanService } from '../../../core/daily-plan-service.js';
import type { TaskService } from '../../../core/task-service.js';
import type { StitchDb } from '../../../db/index.js';
import type { TaskListItem } from '../../../types/task.js';
import { readPredictionFromDb } from '../handlers/text-router.js';
import type { StitchContext } from '../types.js';
import { buildCurrentChunkTasksView } from '../view-builders.js';
import {
	formatCompletionWithDiff,
	renderCurrentChunkTasksView,
	renderHubView,
	renderTaskDetailView,
	renderTasksView,
} from '../views.js';
import { safeEditMessageText } from './helpers.js';

const STATUS_ORDER: Record<string, number> = {
	active: 0,
	pending: 1,
	completed: 2,
	skipped: 3,
};

function taskButtonLabel(task: TaskListItem): string {
	const maxLen = 30;
	const name = task.name.length > maxLen ? `${task.name.slice(0, maxLen)}...` : task.name;

	if (task.timerStartedAt) return `\u25B6 ${name}`;
	if (task.isEssential) return `\uD83D\uDD12 ${name}`;
	if (task.status === 'completed') return `\u2705 ${name}`;
	if (task.status === 'skipped') return `\u23ED ${name}`;
	return name;
}

function sortTasks(list: TaskListItem[]): TaskListItem[] {
	return [...list].sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9));
}

/**
 * Factory for a task detail menu instance.
 *
 * Phase 08.3 registers two instances of the same logical menu under different
 * parents (OQ-1 resolution, option c):
 *   - `task-detail-from-chunk` registered under `tasksMenu` (scoped view)
 *   - `task-detail-from-all`   registered under `allTasksMenu` (all tasks view)
 *
 * Both instances share identical start/stop/done/postpone/delete button
 * handlers and differ ONLY in the back-button render target: the chunk origin
 * returns to the scoped tasks view, the all-tasks origin returns to the full
 * task list.
 *
 * `ctx.menu.back()` is used for the back button (and for post-action returns)
 * so grammY's registered-parent relationship routes correctly without
 * additional session state.
 */
function buildTaskDetailMenu(
	menuId: 'task-detail-from-chunk' | 'task-detail-from-all',
	taskService: TaskService,
	renderParentText: () => string,
	checkInService?: CheckInService, // Phase 9 D-05.4 (Blocker 4)
	db?: StitchDb, // Phase 10 D-18: prediction lookup for completion diff
): Menu<StitchContext> {
	return new Menu<StitchContext>(menuId).dynamic((ctx, range) => {
		const taskId = ctx.match;
		if (!taskId) return range;

		const task = taskService.getById(Number(taskId));
		if (!task) {
			// Task deleted or invalid -- just show back button with payload
			// so dimension check passes on click
			range
				.text({ text: '<< Back to Tasks', payload: String(taskId) }, async (ctx) => {
					// biome-ignore lint: back() required for dynamic submenu nav
					ctx.menu.back();
					await safeEditMessageText(ctx, renderParentText());
				})
				.row();
			return range;
		}

		// Completed or skipped: only back button
		if (task.status === 'completed' || task.status === 'skipped') {
			range
				.text({ text: '<< Back to Tasks', payload: String(task.id) }, async (ctx) => {
					// biome-ignore lint: back() required for dynamic submenu nav
					ctx.menu.back();
					await safeEditMessageText(ctx, renderParentText());
				})
				.row();
			return range;
		}

		// Timer running: only Stop Timer + back
		if (task.timerStartedAt) {
			range
				.text({ text: 'Stop Timer', payload: String(task.id) }, async (ctx) => {
					try {
						taskService.stopTimer(task.id);
						const detail = taskService.getTaskDetail(task.id);
						if (detail) {
							await safeEditMessageText(ctx, renderTaskDetailView(detail));
						}
					} catch (err) {
						await safeEditMessageText(ctx, String((err as Error).message));
					}
				})
				.row();
			range
				.text({ text: '<< Back to Tasks', payload: String(task.id) }, async (ctx) => {
					// biome-ignore lint: back() required for dynamic submenu nav
					ctx.menu.back();
					await safeEditMessageText(ctx, renderParentText());
				})
				.row();
			return range;
		}

		// Timer not running, status pending or active: Start Timer
		if (task.status === 'pending' || task.status === 'active') {
			range
				.text({ text: 'Start Timer', payload: String(task.id) }, async (ctx) => {
					try {
						taskService.startTimer(task.id);
						const detail = taskService.getTaskDetail(task.id);
						if (detail) {
							await safeEditMessageText(ctx, renderTaskDetailView(detail));
						}
					} catch (err) {
						await safeEditMessageText(ctx, String((err as Error).message));
					}
				})
				.row();
		}

		// Not essential, not timer running, pending: Postpone + Complete
		if (!task.isEssential && task.status === 'pending') {
			range
				.text({ text: 'Postpone', payload: String(task.id) }, async (ctx) => {
					try {
						taskService.postpone(task.id);
						checkInService?.forceCheckIn('task_action').catch(() => {}); // Phase 9 D-05.4 (Blocker 4)
						const detail = taskService.getTaskDetail(task.id);
						if (detail) {
							await safeEditMessageText(ctx, renderTaskDetailView(detail));
						}
					} catch (err) {
						await safeEditMessageText(ctx, String((err as Error).message));
					}
				})
				.text({ text: 'Complete', payload: String(task.id) }, async (ctx) => {
					try {
						const hadTimer = !!task.timerStartedAt;
						const pred = readPredictionFromDb(db, task.id);
						let actualSeconds = 0;
						if (hadTimer) {
							actualSeconds = taskService.stopTimer(task.id);
						}
						taskService.update(task.id, { status: 'completed' });
						checkInService?.forceCheckIn('task_action').catch(() => {}); // Phase 9 D-05.4 (Blocker 4)

						if (hadTimer) {
							const diffText = formatCompletionWithDiff(
								task.name,
								task.id,
								actualSeconds,
								pred.predictedMaxSeconds,
								pred.predictedConfidence,
							);
							await ctx.answerCallbackQuery(diffText.replace('\n', ' \u2014 '));
						}

						// biome-ignore lint: back() required for dynamic submenu nav
						ctx.menu.back();
						await safeEditMessageText(ctx, renderParentText());
					} catch (err) {
						await safeEditMessageText(ctx, String((err as Error).message));
					}
				})
				.row();
		}

		// Essential, not timer running: Complete only
		if (task.isEssential) {
			range
				.text({ text: 'Complete', payload: String(task.id) }, async (ctx) => {
					try {
						const hadTimer = !!task.timerStartedAt;
						const pred = readPredictionFromDb(db, task.id);
						let actualSeconds = 0;
						if (hadTimer) {
							actualSeconds = taskService.stopTimer(task.id);
						}
						taskService.update(task.id, { status: 'completed' });
						checkInService?.forceCheckIn('task_action').catch(() => {}); // Phase 9 D-05.4 (Blocker 4)

						if (hadTimer) {
							const diffText = formatCompletionWithDiff(
								task.name,
								task.id,
								actualSeconds,
								pred.predictedMaxSeconds,
								pred.predictedConfidence,
							);
							await ctx.answerCallbackQuery(diffText.replace('\n', ' \u2014 '));
						}

						// biome-ignore lint: back() required for dynamic submenu nav
						ctx.menu.back();
						await safeEditMessageText(ctx, renderParentText());
					} catch (err) {
						await safeEditMessageText(ctx, String((err as Error).message));
					}
				})
				.row();
		}

		// Not essential, not timer running: Delete
		if (!task.isEssential) {
			range
				.text({ text: 'Delete', payload: String(task.id) }, async (ctx) => {
					try {
						taskService.delete(task.id);
						// biome-ignore lint: back() required for dynamic submenu nav
						ctx.menu.back();
						await safeEditMessageText(ctx, renderParentText());
					} catch (err) {
						await safeEditMessageText(ctx, String((err as Error).message));
					}
				})
				.row();
		}

		// Back button inside dynamic so it carries task ID payload
		// (grammY dimension check needs ctx.match = task ID to render correctly)
		range
			.text({ text: '<< Back to Tasks', payload: String(task.id) }, async (ctx) => {
				// biome-ignore lint: back() required for dynamic submenu nav
				ctx.menu.back();
				await safeEditMessageText(ctx, renderParentText());
			})
			.row();

		return range;
	});
}

/**
 * Phase 08.3 Wave 3: Tasks menu restructure per UI-SPEC Screens 3-4 + D-21.
 *
 * The main `tasks` menu defaults to current-chunk scoping:
 *   - Dynamic task buttons populated from
 *     `buildCurrentChunkTasksView(taskService, dailyPlanService, new Date()).chunk?.tasks`
 *   - [All Tasks] drill-down to the full task pool in a separate submenu
 *   - [Refresh] re-queries scoped tasks at click time (Pitfall 7)
 *   - [<< Back to Hub]
 *
 * The new `all-tasks` submenu mirrors the layout with the full list from
 * `taskService.list()`:
 *   - Dynamic task buttons for every task row
 *   - [Refresh] re-queries all-tasks at click time
 *   - [<< Back to Tasks] returns to the scoped view
 *
 * Task Detail is registered as TWO menu instances (OQ-1 option c):
 *   - `task-detail-from-chunk` under `tasksMenu` so `back()` returns to scoped
 *   - `task-detail-from-all`   under `allTasksMenu` so `back()` returns to all
 *
 * All refresh + render handlers use `safeEditMessageText` for idempotent
 * refresh handling and follow the grammY nav-before-edit contract.
 */
export function createTasksMenu(
	taskService: TaskService,
	dailyPlanService?: DailyPlanService,
	checkInService?: CheckInService, // Phase 9 D-05.4 (Blocker 4)
	db?: StitchDb, // Phase 10 D-18: prediction lookup for completion diff
): {
	tasksMenu: Menu<StitchContext>;
	taskDetailMenu: Menu<StitchContext>;
	allTasksMenu: Menu<StitchContext>;
	taskDetailFromAllMenu: Menu<StitchContext>;
} {
	// Build task-detail menu instances. Each instance's back handler renders
	// the appropriate parent view.
	const taskDetailFromChunk = buildTaskDetailMenu(
		'task-detail-from-chunk',
		taskService,
		() =>
			renderCurrentChunkTasksView(
				buildCurrentChunkTasksView(taskService, dailyPlanService, new Date()),
			),
		checkInService,
		db,
	);

	const taskDetailFromAll = buildTaskDetailMenu(
		'task-detail-from-all',
		taskService,
		() => renderTasksView(taskService.list() as TaskListItem[]),
		checkInService,
		db,
	);

	// Main scoped tasks menu (Screen 3).
	const tasksMenu = new Menu<StitchContext>('tasks')
		.dynamic((_ctx, range) => {
			const view = buildCurrentChunkTasksView(taskService, dailyPlanService, new Date());
			const tasks = view?.chunk?.tasks ?? [];
			const sorted = sortTasks(tasks).slice(0, 20);

			for (const task of sorted) {
				range
					.text({ text: taskButtonLabel(task), payload: String(task.id) }, async (ctx) => {
						try {
							const detail = taskService.getTaskDetail(Number(ctx.match));
							if (detail) {
								ctx.menu.nav('task-detail-from-chunk');
								await safeEditMessageText(ctx, renderTaskDetailView(detail));
							}
						} catch (err) {
							await safeEditMessageText(ctx, String((err as Error).message));
						}
					})
					.row();
			}
			return range;
		})
		.text('All Tasks', async (ctx) => {
			ctx.menu.nav('all-tasks');
			await safeEditMessageText(ctx, renderTasksView(taskService.list() as TaskListItem[]));
		})
		.text('Refresh', async (ctx) => {
			// No nav -- re-render same menu. CLICK-TIME re-query (Pitfall 7).
			await safeEditMessageText(
				ctx,
				renderCurrentChunkTasksView(
					buildCurrentChunkTasksView(taskService, dailyPlanService, new Date()),
				),
			);
		})
		.row()
		.text('<< Back to Hub', async (ctx) => {
			ctx.menu.nav('hub');
			await safeEditMessageText(
				ctx,
				renderHubView({
					status: 'idle',
					currentChunk: null,
					timer: null,
					timerSince: null,
				}),
			);
		});

	// All Tasks drill-down submenu (Screen 4).
	const allTasksMenu = new Menu<StitchContext>('all-tasks')
		.dynamic((_ctx, range) => {
			const all = sortTasks(taskService.list() as TaskListItem[]).slice(0, 20);
			for (const task of all) {
				range
					.text({ text: taskButtonLabel(task), payload: String(task.id) }, async (ctx) => {
						try {
							const detail = taskService.getTaskDetail(Number(ctx.match));
							if (detail) {
								ctx.menu.nav('task-detail-from-all');
								await safeEditMessageText(ctx, renderTaskDetailView(detail));
							}
						} catch (err) {
							await safeEditMessageText(ctx, String((err as Error).message));
						}
					})
					.row();
			}
			return range;
		})
		.text('Refresh', async (ctx) => {
			// No nav -- re-render same menu. CLICK-TIME re-query.
			await safeEditMessageText(ctx, renderTasksView(taskService.list() as TaskListItem[]));
		})
		.row()
		.text('<< Back to Tasks', async (ctx) => {
			ctx.menu.nav('tasks');
			await safeEditMessageText(
				ctx,
				renderCurrentChunkTasksView(
					buildCurrentChunkTasksView(taskService, dailyPlanService, new Date()),
				),
			);
		});

	// Register task-detail instances under their respective parents so
	// `ctx.menu.back()` routes correctly via the registered-parent relationship.
	tasksMenu.register(taskDetailFromChunk);
	tasksMenu.register(allTasksMenu);
	allTasksMenu.register(taskDetailFromAll);

	// `taskDetailMenu` field preserved on the return shape for backward compat
	// with the `RegisteredMenus` interface (now points to the chunk-origin
	// instance, which is the scoped-view path -- the one reachable from the
	// default Tasks view).
	return {
		tasksMenu,
		taskDetailMenu: taskDetailFromChunk,
		allTasksMenu,
		taskDetailFromAllMenu: taskDetailFromAll,
	};
}

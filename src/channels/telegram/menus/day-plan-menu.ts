import { Menu } from '@grammyjs/menu';
import type { DailyPlanService } from '../../../core/daily-plan-service.js';
import type { DayTreeService } from '../../../core/day-tree-service.js';
import type { StitchContext } from '../types.js';
import {
	renderCurrentChunkView,
	renderDayPlanView,
	renderHubView,
	renderTreeView,
} from '../views.js';
import {
	buildCurrentChunkView,
	buildFullDayPlanView,
} from '../view-builders.js';
import { safeEditMessageText } from './helpers.js';

/**
 * Phase 08.3 Wave 3: Day Plan menu restructure per UI-SPEC Screens 1-2 +
 * Navigation Graph.
 *
 * Main `day-plan` menu defaults to `renderCurrentChunkView` (focused current
 * chunk) and offers drill-downs to Full Day Plan (Screen 2) and View Day Tree.
 *
 * Layout (UI-SPEC Screen 1):
 *   Row 1: [ Full Day Plan ] [ View Day Tree ]
 *   Row 2: [           Refresh             ]
 *   Row 3: [         << Back to Hub        ]
 *
 * Every handler follows the grammY nav-before-edit contract (call
 * `ctx.menu.nav()` BEFORE `safeEditMessageText`) and uses `safeEditMessageText`
 * so idempotent refresh does not throw "message is not modified".
 *
 * Every Refresh handler re-calls `buildCurrentChunkView(dailyPlanService)` /
 * `buildFullDayPlanView(dailyPlanService)` AT CLICK TIME (Pitfall 7) rather
 * than capturing a view object in the closure at menu construction time. The
 * builders use `new Date()` per call so refresh at 11:59 vs 12:01 yields
 * different results across a chunk boundary (D-19 invariant).
 */
export function createDayPlanMenu(
	dayTreeService?: DayTreeService,
	dailyPlanService?: DailyPlanService,
): Menu<StitchContext> {
	const menu = new Menu<StitchContext>('day-plan')
		.text('Full Day Plan', async (ctx) => {
			ctx.menu.nav('full-day-plan');
			await safeEditMessageText(
				ctx,
				renderDayPlanView(buildFullDayPlanView(dailyPlanService), 'full'),
			);
		})
		.text('View Day Tree', async (ctx) => {
			if (!dayTreeService) {
				await ctx.answerCallbackQuery('No day tree service available.');
				return;
			}
			const tree = dayTreeService.getTree();
			if (!tree) {
				await ctx.answerCallbackQuery('No day tree set yet.');
				return;
			}
			ctx.menu.nav('day-tree-view');
			await safeEditMessageText(ctx, renderTreeView(tree));
		})
		.row()
		.text('Refresh', async (ctx) => {
			// No nav -- re-render same menu. CLICK-TIME re-query (Pitfall 7).
			await safeEditMessageText(
				ctx,
				renderCurrentChunkView(buildCurrentChunkView(dailyPlanService)),
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

	/**
	 * Full Day Plan submenu (Screen 2). Renders all branches/chunks via
	 * `renderDayPlanView(view, 'full')`. Refresh re-renders at click time,
	 * Back returns to the focused Day Plan (not Hub) per D-21.
	 */
	const fullDayPlanMenu = new Menu<StitchContext>('full-day-plan')
		.text('Refresh', async (ctx) => {
			await safeEditMessageText(
				ctx,
				renderDayPlanView(buildFullDayPlanView(dailyPlanService), 'full'),
			);
		})
		.row()
		.text('<< Back to Day Plan', async (ctx) => {
			ctx.menu.nav('day-plan');
			await safeEditMessageText(
				ctx,
				renderCurrentChunkView(buildCurrentChunkView(dailyPlanService)),
			);
		});

	/**
	 * Day Tree View submenu. Back button now navigates to Day Plan (focused)
	 * rather than Hub -- this is the D-21 behavior change from Phase 08.2.
	 */
	const treeViewMenu = new Menu<StitchContext>('day-tree-view').text(
		'<< Back to Day Plan',
		async (ctx) => {
			ctx.menu.nav('day-plan');
			await safeEditMessageText(
				ctx,
				renderCurrentChunkView(buildCurrentChunkView(dailyPlanService)),
			);
		},
	);

	menu.register(fullDayPlanMenu);
	menu.register(treeViewMenu);

	return menu;
}

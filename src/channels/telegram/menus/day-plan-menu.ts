import { Menu } from '@grammyjs/menu';
import type { DayTreeService } from '../../../core/day-tree-service.js';
import type { StitchContext } from '../types.js';
import { renderHubView, renderTreeView } from '../views.js';

export function createDayPlanMenu(dayTreeService?: DayTreeService): Menu<StitchContext> {
	const menu = new Menu<StitchContext>('day-plan')
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
			await ctx.editMessageText(renderTreeView(tree), { parse_mode: 'HTML' });
		})
		.row()
		.text('<< Back to Hub', async (ctx) => {
			ctx.menu.nav('hub');
			await ctx.editMessageText(
				renderHubView({ status: 'idle', currentChunk: null, timer: null, timerSince: null }),
				{ parse_mode: 'HTML' },
			);
		});

	return menu;
}

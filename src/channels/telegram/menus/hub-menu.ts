import { Menu } from '@grammyjs/menu';
import type { StitchContext } from '../types.js';
import { renderDayPlanView, renderHubView, renderTasksView } from '../views.js';

export function createHubMenu(): Menu<StitchContext> {
	const menu = new Menu<StitchContext>('hub')
		.text('Day Plan', async (ctx) => {
			await ctx.editMessageText(renderDayPlanView(), { parse_mode: 'HTML' });
			ctx.menu.nav('day-plan');
		})
		.text('Tasks', async (ctx) => {
			await ctx.editMessageText(renderTasksView(), { parse_mode: 'HTML' });
			ctx.menu.nav('tasks');
		})
		.row()
		.text('Status', async (ctx) => {
			await ctx.editMessageText(
				renderHubView({ status: 'idle', currentChunk: null, timer: null }),
				{ parse_mode: 'HTML' },
			);
		});

	return menu;
}

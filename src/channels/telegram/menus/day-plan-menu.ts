import { Menu } from '@grammyjs/menu';
import type { StitchContext } from '../types.js';
import { renderHubView } from '../views.js';

export function createDayPlanMenu(): Menu<StitchContext> {
	const menu = new Menu<StitchContext>('day-plan').text('<< Back to Hub', async (ctx) => {
		ctx.menu.nav('hub');
		await ctx.editMessageText(renderHubView({ status: 'idle', currentChunk: null, timer: null, timerSince: null }), {
			parse_mode: 'HTML',
		});
	});

	return menu;
}

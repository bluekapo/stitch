import { Menu } from '@grammyjs/menu';
import type { StitchContext } from '../types.js';
import { renderHubView } from '../views.js';

export function createTasksMenu(): Menu<StitchContext> {
	const menu = new Menu<StitchContext>('tasks').text('<< Back to Hub', async (ctx) => {
		await ctx.editMessageText(renderHubView({ status: 'idle', currentChunk: null, timer: null }), {
			parse_mode: 'HTML',
		});
		ctx.menu.nav('hub');
	});

	return menu;
}

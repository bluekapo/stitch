import type { Bot } from 'grammy';
import type { BlueprintService } from '../../../core/blueprint-service.js';
import { createBlueprintSchema, createCycleSchema, createTimeBlockSchema } from '../../../types/blueprint.js';
import type { StitchContext } from '../types.js';
import { renderBlueprintView, renderBlueprintListText } from '../views.js';

export function registerBlueprintHandlers(bot: Bot<StitchContext>, blueprintService: BlueprintService): void {
	// blueprint create <name>
	bot.hears(/^blueprint create (.+)$/i, async (ctx) => {
		const rawName = ctx.match[1].trim();
		const parsed = createBlueprintSchema.safeParse({ name: rawName });
		if (!parsed.success) {
			await ctx.reply('Blueprint name must be 1-100 characters.');
			return;
		}
		try {
			const bp = blueprintService.createBlueprint(parsed.data);
			await ctx.reply(`Blueprint created: ${bp.name} (#${bp.id})`);
		} catch (err) {
			await ctx.reply((err as Error).message);
		}
	});

	// blueprint cycle <blueprintId> <name> <HH:MM>-<HH:MM>
	bot.hears(/^blueprint cycle (\d+) (.+) (\d{2}:\d{2})-(\d{2}:\d{2})$/i, async (ctx) => {
		const blueprintId = Number(ctx.match[1]);
		const name = ctx.match[2].trim();
		const startTime = ctx.match[3];
		const endTime = ctx.match[4];
		const parsed = createCycleSchema.safeParse({ blueprintId, name, startTime, endTime });
		if (!parsed.success) {
			await ctx.reply('Invalid cycle parameters. Use: blueprint cycle <id> <name> HH:MM-HH:MM');
			return;
		}
		try {
			blueprintService.addCycle(parsed.data);
			await ctx.reply(`Cycle added: ${name} (${startTime}-${endTime})`);
		} catch (err) {
			await ctx.reply((err as Error).message);
		}
	});

	// blueprint block <cycleId> <label> <HH:MM>-<HH:MM>  (fixed activity, isSlot=false)
	bot.hears(/^blueprint block (\d+) (.+) (\d{2}:\d{2})-(\d{2}:\d{2})$/i, async (ctx) => {
		const cycleId = Number(ctx.match[1]);
		const label = ctx.match[2].trim();
		const startTime = ctx.match[3];
		const endTime = ctx.match[4];
		const parsed = createTimeBlockSchema.safeParse({ cycleId, label, startTime, endTime, isSlot: false });
		if (!parsed.success) {
			await ctx.reply('Invalid block parameters. Use: blueprint block <cycleId> <label> HH:MM-HH:MM');
			return;
		}
		try {
			blueprintService.addTimeBlock(parsed.data);
			await ctx.reply(`Block added: ${label} (${startTime}-${endTime})`);
		} catch (err) {
			await ctx.reply((err as Error).message);
		}
	});

	// blueprint slot <cycleId> <HH:MM>-<HH:MM>  (available slot, isSlot=true, no label)
	bot.hears(/^blueprint slot (\d+) (\d{2}:\d{2})-(\d{2}:\d{2})$/i, async (ctx) => {
		const cycleId = Number(ctx.match[1]);
		const startTime = ctx.match[2];
		const endTime = ctx.match[3];
		const parsed = createTimeBlockSchema.safeParse({ cycleId, startTime, endTime, isSlot: true });
		if (!parsed.success) {
			await ctx.reply('Invalid slot parameters. Use: blueprint slot <cycleId> HH:MM-HH:MM');
			return;
		}
		try {
			blueprintService.addTimeBlock(parsed.data);
			await ctx.reply(`Slot added: ${startTime}-${endTime}`);
		} catch (err) {
			await ctx.reply((err as Error).message);
		}
	});

	// blueprint activate <id>
	bot.hears(/^blueprint activate (\d+)$/i, async (ctx) => {
		const id = Number(ctx.match[1]);
		try {
			blueprintService.setActive(id);
			await ctx.reply(`Blueprint #${id} activated.`);
		} catch (err) {
			await ctx.reply((err as Error).message);
		}
	});

	// blueprint show
	bot.hears(/^blueprint show$/i, async (ctx) => {
		try {
			const bp = blueprintService.getActiveBlueprint();
			if (!bp) {
				await ctx.reply('No active blueprint. Use "blueprint activate <id>" to set one.');
				return;
			}
			await ctx.reply(renderBlueprintView(bp), { parse_mode: 'HTML' });
		} catch (err) {
			await ctx.reply((err as Error).message);
		}
	});

	// blueprint list
	bot.hears(/^blueprint list$/i, async (ctx) => {
		try {
			const list = blueprintService.listBlueprints();
			await ctx.reply(renderBlueprintListText(list));
		} catch (err) {
			await ctx.reply((err as Error).message);
		}
	});

	// blueprint delete <id>
	bot.hears(/^blueprint delete (\d+)$/i, async (ctx) => {
		const id = Number(ctx.match[1]);
		try {
			blueprintService.deleteBlueprint(id);
			await ctx.reply(`Blueprint #${id} deleted.`);
		} catch (err) {
			await ctx.reply((err as Error).message);
		}
	});
}

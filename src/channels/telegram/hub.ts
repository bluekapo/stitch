import type { Menu } from '@grammyjs/menu';
import type { Api } from 'grammy';
import type { StitchContext } from './types.js';

export interface HubRef {
	chatId: number;
	messageId: number;
}

export class HubManager {
	private ref: HubRef | null = null;

	constructor(private api: Api) {}

	async sendHub(
		chatId: number,
		text: string,
		menu: Menu<StitchContext>,
		ctx?: StitchContext,
	): Promise<void> {
		// Recover hub ref from pinned message if lost (e.g., after restart)
		if (!this.ref || this.ref.chatId !== chatId) {
			try {
				const chat = await this.api.getChat(chatId);
				if ('pinned_message' in chat && chat.pinned_message) {
					this.ref = { chatId, messageId: chat.pinned_message.message_id };
				}
			} catch {
				// Can't recover — will send new hub
			}
		}

		// If hub exists, try to edit in place (prevents duplicate hubs on repeated /start)
		if (this.ref && this.ref.chatId === chatId) {
			try {
				await this.api.editMessageText(this.ref.chatId, this.ref.messageId, text, {
					parse_mode: 'HTML',
					reply_markup: menu,
				});
				return;
			} catch (err: unknown) {
				if (err instanceof Error && err.message.includes('message is not modified')) {
					return; // Content unchanged, no edit needed
				}
				// Message was deleted or too old -- fall through to send new one
			}
		}

		// grammY menus must be sent through ctx.reply — bot.api bypasses the
		// menu's transformer that installs the keyboard fingerprint.
		let msg: { message_id: number };
		if (ctx) {
			msg = await ctx.reply(text, {
				reply_markup: menu,
				parse_mode: 'HTML',
			});
		} else {
			msg = await this.api.sendMessage(chatId, text, {
				reply_markup: menu,
				parse_mode: 'HTML',
			});
		}
		this.ref = { chatId, messageId: msg.message_id };
		await this.api.pinChatMessage(chatId, msg.message_id, {
			disable_notification: true,
		});
	}

	async updateHub(text: string, menu?: Menu<StitchContext>): Promise<void> {
		if (!this.ref) return;
		try {
			await this.api.editMessageText(this.ref.chatId, this.ref.messageId, text, {
				parse_mode: 'HTML',
				reply_markup: menu,
			});
		} catch (err: unknown) {
			if (err instanceof Error && err.message.includes('message is not modified')) {
				return; // Content unchanged, ignore
			}
			throw err;
		}
	}

	getRef(): HubRef | null {
		return this.ref;
	}

	setRef(ref: HubRef): void {
		this.ref = ref;
	}
}

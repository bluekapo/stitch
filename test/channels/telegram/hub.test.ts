import { describe, expect, it, vi } from 'vitest';
import { HubManager } from '../../../src/channels/telegram/hub.js';
import type { Menu } from '@grammyjs/menu';
import type { StitchContext } from '../../../src/channels/telegram/types.js';

function createMockApi() {
	const calls: Array<{ method: string; args: unknown[] }> = [];
	return {
		calls,
		api: {
			sendMessage: vi.fn(async (_chatId: number, _text: string, _opts?: unknown) => {
				calls.push({ method: 'sendMessage', args: [_chatId, _text, _opts] });
				return {
					message_id: 42,
					date: Math.floor(Date.now() / 1000),
					chat: { id: _chatId, type: 'private' as const },
				};
			}),
			editMessageText: vi.fn(
				async (
					_chatId: number,
					_messageId: number,
					_text: string,
					_opts?: unknown,
				) => {
					calls.push({
						method: 'editMessageText',
						args: [_chatId, _messageId, _text, _opts],
					});
					return {
						message_id: _messageId,
						date: Math.floor(Date.now() / 1000),
						chat: { id: _chatId, type: 'private' as const },
					};
				},
			),
			pinChatMessage: vi.fn(async (_chatId: number, _messageId: number, _opts?: unknown) => {
				calls.push({
					method: 'pinChatMessage',
					args: [_chatId, _messageId, _opts],
				});
				return true;
			}),
		},
	};
}

const fakeMenu = {} as Menu<StitchContext>;

describe('HubManager', () => {
	it('sendHub sends message with parse_mode HTML and reply_markup, then pins it', async () => {
		const { api } = createMockApi();
		const hub = new HubManager(api as never);

		await hub.sendHub(123, '<b>Hub</b>', fakeMenu);

		expect(api.sendMessage).toHaveBeenCalledWith(123, '<b>Hub</b>', {
			reply_markup: fakeMenu,
			parse_mode: 'HTML',
		});
		expect(api.pinChatMessage).toHaveBeenCalledWith(123, 42, {
			disable_notification: true,
		});
	});

	it('sendHub stores chatId and messageId in ref', async () => {
		const { api } = createMockApi();
		const hub = new HubManager(api as never);

		await hub.sendHub(123, 'text', fakeMenu);

		expect(hub.getRef()).toEqual({ chatId: 123, messageId: 42 });
	});

	it('updateHub edits message with stored ref', async () => {
		const { api } = createMockApi();
		const hub = new HubManager(api as never);

		// First send to establish ref
		await hub.sendHub(123, 'initial', fakeMenu);

		// Then update
		await hub.updateHub('updated', fakeMenu);

		expect(api.editMessageText).toHaveBeenCalledWith(123, 42, 'updated', {
			parse_mode: 'HTML',
			reply_markup: fakeMenu,
		});
	});

	it('updateHub is no-op when no ref exists (does not throw)', async () => {
		const { api } = createMockApi();
		const hub = new HubManager(api as never);

		// Should not throw
		await hub.updateHub('text');

		expect(api.editMessageText).not.toHaveBeenCalled();
	});

	it('updateHub catches "message is not modified" error silently', async () => {
		const { api } = createMockApi();
		const hub = new HubManager(api as never);

		await hub.sendHub(123, 'text', fakeMenu);

		// Make editMessageText throw "message is not modified"
		api.editMessageText.mockRejectedValueOnce(
			new Error('Bad Request: message is not modified'),
		);

		// Should not throw
		await expect(hub.updateHub('text')).resolves.toBeUndefined();
	});

	it('sendHub on /start when hub already exists edits instead of sending new message', async () => {
		const { api } = createMockApi();
		const hub = new HubManager(api as never);

		// First send
		await hub.sendHub(123, 'first', fakeMenu);
		api.sendMessage.mockClear();

		// Second send to same chat -- should edit, not send new
		await hub.sendHub(123, 'refreshed', fakeMenu);

		expect(api.editMessageText).toHaveBeenCalledWith(123, 42, 'refreshed', {
			parse_mode: 'HTML',
			reply_markup: fakeMenu,
		});
		expect(api.sendMessage).not.toHaveBeenCalled();
	});

	it('sendHub recovery -- if edit fails (message deleted), sends new message and re-pins', async () => {
		const { api } = createMockApi();
		const hub = new HubManager(api as never);

		// First send
		await hub.sendHub(123, 'first', fakeMenu);

		// Make edit fail (simulating deleted message)
		api.editMessageText.mockRejectedValueOnce(
			new Error('Bad Request: message to edit not found'),
		);
		api.sendMessage.mockClear();

		// Second send -- edit fails, should fall through to new send
		await hub.sendHub(123, 'recovered', fakeMenu);

		expect(api.sendMessage).toHaveBeenCalledWith(123, 'recovered', {
			reply_markup: fakeMenu,
			parse_mode: 'HTML',
		});
		expect(api.pinChatMessage).toHaveBeenCalled();
	});
});

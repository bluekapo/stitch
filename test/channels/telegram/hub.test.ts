import type { Menu } from '@grammyjs/menu';
import { describe, expect, it, vi } from 'vitest';
import { HubManager } from '../../../src/channels/telegram/hub.js';
import type { StitchContext } from '../../../src/channels/telegram/types.js';

function createMockApi(pinnedMessageId?: number) {
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
				async (_chatId: number, _messageId: number, _text: string, _opts?: unknown) => {
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
			deleteMessage: vi.fn(async (_chatId: number, _messageId: number) => {
				calls.push({ method: 'deleteMessage', args: [_chatId, _messageId] });
				return true;
			}),
			pinChatMessage: vi.fn(async (_chatId: number, _messageId: number, _opts?: unknown) => {
				calls.push({
					method: 'pinChatMessage',
					args: [_chatId, _messageId, _opts],
				});
				return true;
			}),
			getChat: vi.fn(async (_chatId: number) => {
				calls.push({ method: 'getChat', args: [_chatId] });
				const chat: Record<string, unknown> = { id: _chatId, type: 'private' };
				if (pinnedMessageId !== undefined) {
					chat.pinned_message = {
						message_id: pinnedMessageId,
						date: 0,
						chat: { id: _chatId, type: 'private' },
					};
				}
				return chat;
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
		api.editMessageText.mockRejectedValueOnce(new Error('Bad Request: message is not modified'));

		// Should not throw
		await expect(hub.updateHub('text')).resolves.toBeUndefined();
	});

	it('sendHub on repeated /start deletes old hub and sends new message', async () => {
		const { api } = createMockApi();
		const hub = new HubManager(api as never);

		// First send
		await hub.sendHub(123, 'first', fakeMenu);
		api.sendMessage.mockClear();
		api.pinChatMessage.mockClear();

		// Second send to same chat -- should delete old, send new
		await hub.sendHub(123, 'refreshed', fakeMenu);

		expect(api.deleteMessage).toHaveBeenCalledWith(123, 42);
		expect(api.sendMessage).toHaveBeenCalledWith(123, 'refreshed', {
			reply_markup: fakeMenu,
			parse_mode: 'HTML',
		});
		expect(api.pinChatMessage).toHaveBeenCalled();
		expect(api.editMessageText).not.toHaveBeenCalled();
		// Ref should point to new message
		expect(hub.getRef()).toEqual({ chatId: 123, messageId: 42 });
	});

	it('sendHub recovers ref from pinned message, deletes it, and sends new hub', async () => {
		const { api } = createMockApi(99);
		const hub = new HubManager(api as never);

		// ref is null (simulates restart). Pinned message exists with ID 99.
		await hub.sendHub(123, 'recovered', fakeMenu);

		// Should have called getChat to discover pinned message
		expect(api.getChat).toHaveBeenCalledWith(123);
		// Should delete old pinned message, then send new
		expect(api.deleteMessage).toHaveBeenCalledWith(123, 99);
		expect(api.sendMessage).toHaveBeenCalledWith(123, 'recovered', {
			reply_markup: fakeMenu,
			parse_mode: 'HTML',
		});
		expect(api.pinChatMessage).toHaveBeenCalled();
		expect(api.editMessageText).not.toHaveBeenCalled();
		// Ref should point to the new message, not the old pinned one
		expect(hub.getRef()).toEqual({ chatId: 123, messageId: 42 });
	});

	it('sendHub sends new message when no pinned message exists and ref is null', async () => {
		const { api } = createMockApi(); // no pinned message
		const hub = new HubManager(api as never);

		await hub.sendHub(123, 'fresh', fakeMenu);

		expect(api.getChat).toHaveBeenCalledWith(123);
		expect(api.sendMessage).toHaveBeenCalled();
		expect(api.pinChatMessage).toHaveBeenCalled();
	});

	it('sendHub when deleteMessage fails still sends new hub', async () => {
		const { api } = createMockApi();
		const hub = new HubManager(api as never);

		// First send
		await hub.sendHub(123, 'first', fakeMenu);

		// Make delete fail (message already gone)
		api.deleteMessage.mockRejectedValueOnce(new Error('Bad Request: message to delete not found'));
		api.sendMessage.mockClear();
		api.pinChatMessage.mockClear();

		// Second send -- delete fails, should still send new hub
		await hub.sendHub(123, 'recovered', fakeMenu);

		expect(api.deleteMessage).toHaveBeenCalledWith(123, 42);
		expect(api.sendMessage).toHaveBeenCalledWith(123, 'recovered', {
			reply_markup: fakeMenu,
			parse_mode: 'HTML',
		});
		expect(api.pinChatMessage).toHaveBeenCalled();
		expect(api.editMessageText).not.toHaveBeenCalled();
	});
});

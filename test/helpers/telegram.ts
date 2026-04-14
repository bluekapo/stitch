import { Bot } from 'grammy';
import type { StitchContext } from '../../src/channels/telegram/types.js';

export interface TestBotResult {
	bot: Bot<StitchContext>;
	outgoing: Array<{ method: string; payload: unknown }>;
}

export function createTestBot(): TestBotResult {
	const outgoing: Array<{ method: string; payload: unknown }> = [];
	const bot = new Bot<StitchContext>('fake:token', {
		botInfo: {
			id: 1,
			is_bot: true,
			first_name: 'TestBot',
			username: 'test_bot',
			can_join_groups: false,
			can_read_all_group_messages: false,
			supports_inline_queries: false,
			can_connect_to_business: false,
			has_main_web_app: false,
		},
	});

	bot.api.config.use((_prev, method, payload) => {
		outgoing.push({ method, payload });
		if (method === 'sendMessage') {
			return {
				ok: true,
				result: {
					message_id: Date.now(),
					date: Math.floor(Date.now() / 1000),
					chat: {
						id: (payload as Record<string, unknown>).chat_id ?? 1,
						type: 'private',
					},
				},
			} as never;
		}
		if (method === 'editMessageText') {
			return {
				ok: true,
				result: {
					message_id: (payload as Record<string, unknown>).message_id ?? 1,
					date: Math.floor(Date.now() / 1000),
					chat: {
						id: (payload as Record<string, unknown>).chat_id ?? 1,
						type: 'private',
					},
				},
			} as never;
		}
		if (method === 'getFile') {
			return {
				ok: true,
				result: {
					file_id: (payload as Record<string, unknown>).file_id ?? 'voice-file-id',
					file_unique_id: 'unique-voice-file-id',
					file_path: 'voice/file_0.oga',
					file_size: 1024,
				},
			} as never;
		}
		return { ok: true, result: true } as never;
	});

	return { bot, outgoing };
}

let updateIdCounter = 1000;

export function fakeTextMessageUpdate(text: string, userId = 123): object {
	return {
		update_id: updateIdCounter++,
		message: {
			message_id: updateIdCounter,
			from: { id: userId, is_bot: false, first_name: 'Test' },
			chat: { id: userId, type: 'private' },
			date: Math.floor(Date.now() / 1000),
			text,
		},
	};
}

export function fakeVoiceMessageUpdate(fileId = 'voice-file-id', userId = 123): object {
	return {
		update_id: updateIdCounter++,
		message: {
			message_id: updateIdCounter,
			from: { id: userId, is_bot: false, first_name: 'Test' },
			chat: { id: userId, type: 'private' },
			date: Math.floor(Date.now() / 1000),
			voice: {
				file_id: fileId,
				file_unique_id: `unique-${fileId}`,
				duration: 3,
				mime_type: 'audio/ogg',
				file_size: 1024,
			},
		},
	};
}

export function fakeCallbackQueryUpdate(data: string, userId = 123, messageId = 1): object {
	return {
		update_id: updateIdCounter++,
		callback_query: {
			id: String(updateIdCounter),
			from: { id: userId, is_bot: false, first_name: 'Test' },
			chat_instance: '1',
			data,
			message: {
				message_id: messageId,
				from: { id: 1, is_bot: true, first_name: 'TestBot' },
				chat: { id: userId, type: 'private' },
				date: Math.floor(Date.now() / 1000),
				text: 'old text',
			},
		},
	};
}

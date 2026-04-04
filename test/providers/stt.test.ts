import { describe, expect, it } from 'vitest';
import { MockSttProvider } from '../../src/providers/mock-stt.js';

describe('MockSttProvider', () => {
	it('transcribe() returns the default transcription string "mock transcription"', async () => {
		const provider = new MockSttProvider();
		const result = await provider.transcribe(Buffer.from('audio'), 'audio/wav');
		expect(result).toEqual({ text: 'mock transcription' });
	});

	it('transcribe() returns custom string when constructed with one', async () => {
		const provider = new MockSttProvider('buy groceries');
		const result = await provider.transcribe(Buffer.from('audio'), 'audio/wav');
		expect(result).toEqual({ text: 'buy groceries' });
	});

	it('healthCheck() returns { ok: true }', async () => {
		const provider = new MockSttProvider();
		const health = await provider.healthCheck();
		expect(health).toEqual({ ok: true });
	});
});

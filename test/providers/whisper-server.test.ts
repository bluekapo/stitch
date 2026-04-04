import { afterEach, describe, expect, it, vi } from 'vitest';
import { WhisperServerProvider } from '../../src/providers/whisper-server.js';

describe('WhisperServerProvider', () => {
	describe('transcribe', () => {
		afterEach(() => {
			vi.restoreAllMocks();
		});

		it('sends POST to baseURL/v1/audio/transcriptions with FormData containing file blob', async () => {
			const fetchSpy = vi
				.spyOn(globalThis, 'fetch')
				.mockResolvedValueOnce(
					new Response(JSON.stringify({ text: 'hello world' }), { status: 200 }),
				);

			const provider = new WhisperServerProvider({
				baseURL: 'http://localhost:8081',
			});

			await provider.transcribe(Buffer.from('audio-data'), 'audio/wav');

			expect(fetchSpy).toHaveBeenCalledOnce();
			const [url, options] = fetchSpy.mock.calls[0];
			expect(url).toBe('http://localhost:8081/v1/audio/transcriptions');
			expect(options?.method).toBe('POST');
			expect(options?.body).toBeInstanceOf(FormData);
		});

		it('returns { text: "hello world" } when server responds 200', async () => {
			vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
				new Response(JSON.stringify({ text: 'hello world' }), { status: 200 }),
			);

			const provider = new WhisperServerProvider({
				baseURL: 'http://localhost:8081',
			});

			const result = await provider.transcribe(Buffer.from('audio-data'), 'audio/wav');
			expect(result).toEqual({ text: 'hello world' });
		});

		it('throws Error with message containing "HTTP 400" when server responds 400', async () => {
			vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
				new Response('Bad Request', { status: 400 }),
			);

			const provider = new WhisperServerProvider({
				baseURL: 'http://localhost:8081',
			});

			await expect(provider.transcribe(Buffer.from('bad-audio'), 'audio/wav')).rejects.toThrow(
				'HTTP 400',
			);
		});
	});

	describe('healthCheck', () => {
		afterEach(() => {
			vi.restoreAllMocks();
		});

		it('returns { ok: true } when server responds 200', async () => {
			vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
				new Response(JSON.stringify({ status: 'ok' }), { status: 200 }),
			);

			const provider = new WhisperServerProvider({
				baseURL: 'http://localhost:8081',
			});

			const result = await provider.healthCheck();
			expect(result).toEqual({ ok: true });
		});

		it('returns { ok: false } with error when server responds 503', async () => {
			vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
				new Response('Service Unavailable', { status: 503 }),
			);

			const provider = new WhisperServerProvider({
				baseURL: 'http://localhost:8081',
			});

			const result = await provider.healthCheck();
			expect(result.ok).toBe(false);
			expect(result.error).toBeDefined();
		});

		it('returns { ok: false } with error message when server is unreachable', async () => {
			vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('fetch failed'));

			const provider = new WhisperServerProvider({
				baseURL: 'http://localhost:8081',
			});

			const result = await provider.healthCheck();
			expect(result.ok).toBe(false);
			expect(result.error).toBe('fetch failed');
		});
	});
});

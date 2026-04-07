import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		// Clean env vars that affect config
		delete process.env.PORT;
		delete process.env.LOG_LEVEL;
		delete process.env.LLAMA_SERVER_URL;
		delete process.env.LLAMA_MODEL_NAME;
		delete process.env.LLM_PROVIDER;
		delete process.env.LLM_MAX_RETRIES;
		delete process.env.WHISPER_SERVER_URL;
		delete process.env.STT_PROVIDER;
		delete process.env.TELEGRAM_ALLOWED_USER_ID;
		// TELEGRAM_BOT_TOKEN is required (no default), must be set for loadConfig to succeed
		process.env.TELEGRAM_BOT_TOKEN = 'test:fake-token';
		// Phase 9: WAKE_SECRET is required (no default) — set a valid fixture so existing
		// tests still load. Validation tests for missing/short secret live in the
		// validation describe block and override this per-test.
		process.env.WAKE_SECRET = 'test-wake-secret-fixture-1234567890';
	});

	afterEach(() => {
		process.env = { ...originalEnv };
		vi.restoreAllMocks();
	});

	describe('defaults', () => {
		it('returns PORT=3000 when not set', () => {
			const config = loadConfig();
			expect(config.PORT).toBe(3000);
		});

		it('returns LOG_LEVEL=info when not set', () => {
			const config = loadConfig();
			expect(config.LOG_LEVEL).toBe('info');
		});

		it('returns LLAMA_SERVER_URL=http://localhost:8080 when not set', () => {
			const config = loadConfig();
			expect(config.LLAMA_SERVER_URL).toBe('http://localhost:8080');
		});

		it('returns LLM_PROVIDER=mock when not set', () => {
			const config = loadConfig();
			expect(config.LLM_PROVIDER).toBe('mock');
		});

		it('returns WHISPER_SERVER_URL=http://localhost:8081 when not set', () => {
			const config = loadConfig();
			expect(config.WHISPER_SERVER_URL).toBe('http://localhost:8081');
		});

		it('returns STT_PROVIDER=mock when not set', () => {
			const config = loadConfig();
			expect(config.STT_PROVIDER).toBe('mock');
		});
	});

	describe('overrides', () => {
		it('respects WHISPER_SERVER_URL override', () => {
			process.env.WHISPER_SERVER_URL = 'http://custom-host:9090';
			const config = loadConfig();
			expect(config.WHISPER_SERVER_URL).toBe('http://custom-host:9090');
		});

		it('respects STT_PROVIDER=whisper-server override', () => {
			process.env.STT_PROVIDER = 'whisper-server';
			const config = loadConfig();
			expect(config.STT_PROVIDER).toBe('whisper-server');
		});

		it('respects LLM_PROVIDER=llama-server override', () => {
			process.env.LLM_PROVIDER = 'llama-server';
			const config = loadConfig();
			expect(config.LLM_PROVIDER).toBe('llama-server');
		});
	});

	describe('validation', () => {
		it('calls process.exit(1) when STT_PROVIDER is invalid value', () => {
			process.env.STT_PROVIDER = 'invalid-provider';
			const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
				throw new Error('process.exit called');
			});

			expect(() => loadConfig()).toThrow('process.exit called');
			expect(exitSpy).toHaveBeenCalledWith(1);
		});

		it('calls process.exit(1) when LLM_PROVIDER is invalid value', () => {
			process.env.LLM_PROVIDER = 'invalid-provider';
			const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
				throw new Error('process.exit called');
			});

			expect(() => loadConfig()).toThrow('process.exit called');
			expect(exitSpy).toHaveBeenCalledWith(1);
		});

		it('calls process.exit(1) when WHISPER_SERVER_URL is not a valid URL', () => {
			process.env.WHISPER_SERVER_URL = 'not-a-url';
			const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
				throw new Error('process.exit called');
			});

			expect(() => loadConfig()).toThrow('process.exit called');
			expect(exitSpy).toHaveBeenCalledWith(1);
		});
	});
});

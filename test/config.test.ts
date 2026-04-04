import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';

/**
 * Tests for loadConfig() in src/config.ts.
 *
 * Strategy: isolate process.env around each test so env vars from the test
 * runner (e.g. PORT set by another process) do not bleed into assertions.
 * We snapshot the original env, wipe it, set only what we need, then restore.
 */

let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
	originalEnv = { ...process.env };
	// Remove all Stitch-specific env vars so defaults are truly tested
	delete process.env.PORT;
	delete process.env.LOG_LEVEL;
	delete process.env.LLM_PROVIDER;
	delete process.env.LLAMA_SERVER_URL;
	delete process.env.LLAMA_MODEL_NAME;
	delete process.env.LLM_MAX_RETRIES;
});

afterEach(() => {
	process.env = originalEnv;
	vi.restoreAllMocks();
});

describe('loadConfig() — default values', () => {
	it('returns PORT=3000 when PORT is not set', () => {
		const config = loadConfig();
		expect(config.PORT).toBe(3000);
	});

	it('returns LOG_LEVEL=info when LOG_LEVEL is not set', () => {
		const config = loadConfig();
		expect(config.LOG_LEVEL).toBe('info');
	});

	it('returns LLM_PROVIDER=mock when LLM_PROVIDER is not set', () => {
		const config = loadConfig();
		expect(config.LLM_PROVIDER).toBe('mock');
	});

	it('returns LLAMA_SERVER_URL=http://localhost:8080 when LLAMA_SERVER_URL is not set', () => {
		const config = loadConfig();
		expect(config.LLAMA_SERVER_URL).toBe('http://localhost:8080');
	});

	it('returns LLAMA_MODEL_NAME=qwen3.5-9b when LLAMA_MODEL_NAME is not set', () => {
		const config = loadConfig();
		expect(config.LLAMA_MODEL_NAME).toBe('qwen3.5-9b');
	});

	it('returns LLM_MAX_RETRIES=2 when LLM_MAX_RETRIES is not set', () => {
		const config = loadConfig();
		expect(config.LLM_MAX_RETRIES).toBe(2);
	});
});

describe('loadConfig() — env var overrides', () => {
	it('respects PORT override', () => {
		process.env.PORT = '4000';
		const config = loadConfig();
		expect(config.PORT).toBe(4000);
	});

	it('respects LOG_LEVEL override', () => {
		process.env.LOG_LEVEL = 'debug';
		const config = loadConfig();
		expect(config.LOG_LEVEL).toBe('debug');
	});

	it('respects LLM_PROVIDER=llama-server override', () => {
		process.env.LLM_PROVIDER = 'llama-server';
		const config = loadConfig();
		expect(config.LLM_PROVIDER).toBe('llama-server');
	});

	it('respects LLAMA_SERVER_URL override', () => {
		process.env.LLAMA_SERVER_URL = 'http://192.168.1.100:8080';
		const config = loadConfig();
		expect(config.LLAMA_SERVER_URL).toBe('http://192.168.1.100:8080');
	});

	it('respects LLAMA_MODEL_NAME override', () => {
		process.env.LLAMA_MODEL_NAME = 'llama3-8b';
		const config = loadConfig();
		expect(config.LLAMA_MODEL_NAME).toBe('llama3-8b');
	});

	it('respects LLM_MAX_RETRIES override', () => {
		process.env.LLM_MAX_RETRIES = '5';
		const config = loadConfig();
		expect(config.LLM_MAX_RETRIES).toBe(5);
	});
});

describe('loadConfig() — type coercion', () => {
	it('coerces PORT from string to number', () => {
		process.env.PORT = '8080';
		const config = loadConfig();
		expect(typeof config.PORT).toBe('number');
		expect(config.PORT).toBe(8080);
	});

	it('coerces LLM_MAX_RETRIES from string to number', () => {
		process.env.LLM_MAX_RETRIES = '3';
		const config = loadConfig();
		expect(typeof config.LLM_MAX_RETRIES).toBe('number');
		expect(config.LLM_MAX_RETRIES).toBe(3);
	});
});

describe('loadConfig() — LLM_PROVIDER enum validation', () => {
	it('accepts llama-server as a valid LLM_PROVIDER', () => {
		process.env.LLM_PROVIDER = 'llama-server';
		// Should not throw or call process.exit
		const config = loadConfig();
		expect(config.LLM_PROVIDER).toBe('llama-server');
	});

	it('accepts mock as a valid LLM_PROVIDER', () => {
		process.env.LLM_PROVIDER = 'mock';
		const config = loadConfig();
		expect(config.LLM_PROVIDER).toBe('mock');
	});

	it('calls process.exit(1) when LLM_PROVIDER is an invalid value', () => {
		process.env.LLM_PROVIDER = 'openai'; // not in enum
		const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code) => {
			throw new Error('process.exit called');
		});

		expect(() => loadConfig()).toThrow('process.exit called');
		expect(exitSpy).toHaveBeenCalledWith(1);
	});
});

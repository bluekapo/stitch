import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LlmProvider } from '../../src/providers/llm.js';
import type { SttProvider } from '../../src/providers/stt.js';
import { buildTestApp } from '../helpers/app.js';

describe('Health routes', () => {
	let app: FastifyInstance;

	beforeEach(async () => {
		app = buildTestApp();
		await app.ready();
	});

	afterEach(async () => {
		await app.close();
	});

	it('GET /health returns 200 with status ok', async () => {
		const response = await app.inject({
			method: 'GET',
			url: '/health',
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ status: 'ok' });
	});

	it('GET /health returns correct content-type', async () => {
		const response = await app.inject({
			method: 'GET',
			url: '/health',
		});

		expect(response.headers['content-type']).toMatch(/application\/json/);
	});

	it('GET /health/llm returns 200 with mock provider', async () => {
		const response = await app.inject({
			method: 'GET',
			url: '/health/llm',
		});

		expect(response.statusCode).toBe(200);
		const body = response.json();
		expect(body.status).toBe('ok');
		expect(body.provider).toBe('mock');
	});

	it('GET /health/llm returns 503 when provider reports unhealthy', async () => {
		// Create an unhealthy mock provider
		const unhealthyProvider: LlmProvider = {
			complete: async () => {
				throw new Error('not implemented');
			},
			healthCheck: async () => ({
				ok: false,
				error: 'Server unreachable',
			}),
		};

		// Inject unhealthy provider via buildTestApp's providers parameter
		const unhealthyApp = buildTestApp(undefined, { llmProvider: unhealthyProvider });
		await unhealthyApp.ready();

		const response = await unhealthyApp.inject({
			method: 'GET',
			url: '/health/llm',
		});

		expect(response.statusCode).toBe(503);
		const body = response.json();
		expect(body.status).toBe('unavailable');
		expect(body.error).toBe('Server unreachable');

		await unhealthyApp.close();
	});

	it('GET /health/stt returns 200 with mock provider', async () => {
		const response = await app.inject({
			method: 'GET',
			url: '/health/stt',
		});

		expect(response.statusCode).toBe(200);
		const body = response.json();
		expect(body.status).toBe('ok');
		expect(body.provider).toBe('mock');
	});

	it('GET /health/stt returns 503 when provider reports unhealthy', async () => {
		const unhealthySttProvider: SttProvider = {
			transcribe: async () => {
				throw new Error('not implemented');
			},
			healthCheck: async () => ({
				ok: false,
				error: 'Server unreachable',
			}),
		};

		const unhealthyApp = buildTestApp(undefined, { sttProvider: unhealthySttProvider });
		await unhealthyApp.ready();

		const response = await unhealthyApp.inject({
			method: 'GET',
			url: '/health/stt',
		});

		expect(response.statusCode).toBe(503);
		const body = response.json();
		expect(body.status).toBe('unavailable');
		expect(body.error).toBe('Server unreachable');

		await unhealthyApp.close();
	});
});

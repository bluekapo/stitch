import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
});

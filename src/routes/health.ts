import type { FastifyInstance } from 'fastify';
import type { LlmProvider } from '../providers/llm.js';
import type { SttProvider } from '../providers/stt.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
	app.get('/health', async (_request, reply) => {
		return reply.send({ status: 'ok' });
	});

	app.get('/health/llm', async (_request, reply) => {
		// Cast needed because Fastify decorators aren't typed by default.
		// Type augmentation can be added in a future phase if needed.
		const provider = (app as unknown as { llmProvider: LlmProvider }).llmProvider;
		const config = (
			app as unknown as {
				config: { LLM_PROVIDER: string };
			}
		).config;

		const health = await provider.healthCheck();
		if (health.ok) {
			return reply.send({
				status: 'ok',
				provider: config.LLM_PROVIDER,
			});
		}
		return reply.status(503).send({
			status: 'unavailable',
			error: health.error,
		});
	});

	app.get('/health/stt', async (_request, reply) => {
		const provider = (app as unknown as { sttProvider: SttProvider }).sttProvider;
		const config = (
			app as unknown as {
				config: { STT_PROVIDER: string };
			}
		).config;

		const health = await provider.healthCheck();
		if (health.ok) {
			return reply.send({
				status: 'ok',
				provider: config.STT_PROVIDER,
			});
		}
		return reply.status(503).send({
			status: 'unavailable',
			error: health.error,
		});
	});
}

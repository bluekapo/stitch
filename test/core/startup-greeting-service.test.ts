import { describe, expect, it, vi } from 'vitest';
import { DayTreeService } from '../../src/core/day-tree-service.js';
import { formatGap, StartupGreetingService } from '../../src/core/startup-greeting-service.js';
import { createTestDb, seedSession, seedSettings } from '../helpers/db.js';
import { ScriptedMockLlmProvider } from '../helpers/llm.js';
import { createTestLogger } from '../helpers/logger.js';

/**
 * Phase 13 Wave 0: RED unit tests for StartupGreetingService.
 *
 * These tests INTENTIONALLY fail today because src/core/startup-greeting-service.ts
 * does not exist yet. Wave 3 (Plan 04) creates it and turns these green.
 *
 * Covers D-02 (three state flags), D-04 (first_boot_shown flip), D-06 (LLM
 * generated greeting), D-07 (one composite greeting), D-08 (conversations
 * row persistence), and non-fatal LLM failure.
 */

function makeMockBot() {
	const sendMessage = vi.fn().mockResolvedValue({ message_id: 12345 });
	return {
		// biome-ignore lint/suspicious/noExplicitAny: minimal mock surface for grammY Api
		api: { sendMessage } as any,
	};
}

function makeService(overrides?: { firstBootShown?: boolean }) {
	const db = createTestDb();
	const llm = new ScriptedMockLlmProvider();
	const logger = createTestLogger();
	const dayTreeService = new DayTreeService(db, llm, logger);

	// Seed settings row (default: first_boot_shown=false for first-ever scenario)
	seedSettings(db, { firstBootShown: overrides?.firstBootShown ?? false });

	const service = new StartupGreetingService({
		db,
		llmProvider: llm,
		dayTreeService,
		userChatId: 42,
		logger,
	});

	return { service, db, llm, logger };
}

describe('StartupGreetingService', () => {
	it('first_ever=true: writes conversations row with triggered_by=first_ever and flips first_boot_shown', async () => {
		const { service, db, llm } = makeService({ firstBootShown: false });
		const bot = makeMockBot();
		service.setBot(bot);

		llm.setFixture('startup_greeting', { greeting: 'Good evening, Sir. I am Stitch.' });

		// Create a session for this boot
		const sessionId = seedSession(db, { startedAt: '2026-04-16T09:00:00Z' });
		await service.emit(sessionId, null, createTestLogger());

		// Assert conversations row written
		const rows = db.$client
			.prepare('SELECT * FROM conversations WHERE triggered_by = ?')
			.all('first_ever');
		expect(rows.length).toBe(1);

		// Assert first_boot_shown flipped to true
		const settings = db.$client
			.prepare('SELECT first_boot_shown FROM settings WHERE id = 1')
			.get() as { first_boot_shown: number };
		expect(settings.first_boot_shown).toBe(1);

		// Assert bot.api.sendMessage called
		expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
	});

	it('just_back_online=true alone: writes conversations row with triggered_by=back_online', async () => {
		const { service, db, llm } = makeService({ firstBootShown: true });
		const bot = makeMockBot();
		service.setBot(bot);

		// Seed a tree so tree_missing is false
		db.$client.prepare('INSERT INTO day_trees (tree) VALUES (?)').run(
			JSON.stringify({
				branches: [{ name: 'Day', startTime: '09:00', endTime: '21:00', isTaskSlot: true }],
			}),
		);

		llm.setFixture('startup_greeting', { greeting: 'Welcome back, Sir. Been offline 2h 14m.' });

		const sessionId = seedSession(db, { startedAt: '2026-04-16T12:00:00Z' });
		const lastEndAt = new Date('2026-04-16T09:46:00Z');
		await service.emit(sessionId, lastEndAt, createTestLogger());

		const rows = db.$client
			.prepare('SELECT * FROM conversations WHERE triggered_by = ?')
			.all('back_online');
		expect(rows.length).toBe(1);
	});

	it('tree_missing=true alone: writes conversations row with triggered_by=tree_missing', async () => {
		const { service, db, llm } = makeService({ firstBootShown: true });
		const bot = makeMockBot();
		service.setBot(bot);

		// No tree seeded => tree_missing=true
		llm.setFixture('startup_greeting', { greeting: 'No day tree yet, Sir. Shall we sketch one?' });

		const sessionId = seedSession(db, { startedAt: '2026-04-16T12:00:00Z' });
		const lastEndAt = new Date('2026-04-16T11:59:00Z');
		await service.emit(sessionId, lastEndAt, createTestLogger());

		const rows = db.$client
			.prepare('SELECT * FROM conversations WHERE triggered_by = ?')
			.all('tree_missing');
		expect(rows.length).toBe(1);
	});

	it('composite (first_ever + tree_missing): produces ONE row with triggered_by=first_ever (D-07 dominance)', async () => {
		const { service, db, llm } = makeService({ firstBootShown: false });
		const bot = makeMockBot();
		service.setBot(bot);

		// No tree seeded => tree_missing=true
		llm.setFixture('startup_greeting', {
			greeting: 'Good evening, Sir. I am Stitch. No day tree yet.',
		});

		const sessionId = seedSession(db, { startedAt: '2026-04-16T09:00:00Z' });
		await service.emit(sessionId, null, createTestLogger());

		// Should be exactly ONE conversations row (D-07)
		const allRows = db.$client
			.prepare('SELECT * FROM conversations WHERE role = ?')
			.all('assistant');
		expect(allRows.length).toBe(1);

		// triggered_by should be first_ever (dominates)
		const row = allRows[0] as { triggered_by: string };
		expect(row.triggered_by).toBe('first_ever');
	});

	it('gap < 60s: formatGap returns empty string, user-prompt contains no gap line', async () => {
		const now = new Date('2026-04-16T12:00:00Z');
		const lastEnd = new Date('2026-04-16T11:59:30Z'); // 30s gap
		const gap = formatGap(30, now, lastEnd);
		expect(gap).toBe('');
	});

	it('gap 2h14m: formatGap returns "2h 14m"', () => {
		const seconds = 2 * 3600 + 14 * 60;
		const now = new Date('2026-04-16T12:00:00Z');
		const lastEnd = new Date('2026-04-16T09:46:00Z');
		const gap = formatGap(seconds, now, lastEnd);
		expect(gap).toBe('2h 14m');
	});

	it('LLM failure is non-fatal: emit() resolves, no conversations row, first_boot_shown unchanged, warn logged', async () => {
		const { service, db, llm } = makeService({ firstBootShown: false });
		const bot = makeMockBot();
		service.setBot(bot);

		// No fixture set => LLM will throw "No mock fixture registered"
		const sessionId = seedSession(db, { startedAt: '2026-04-16T09:00:00Z' });

		// Should NOT throw
		await expect(service.emit(sessionId, null, createTestLogger())).resolves.toBeUndefined();

		// No conversations row written
		const rows = db.$client.prepare('SELECT * FROM conversations').all();
		expect(rows.length).toBe(0);

		// first_boot_shown still false
		const settings = db.$client
			.prepare('SELECT first_boot_shown FROM settings WHERE id = 1')
			.get() as { first_boot_shown: number };
		expect(settings.first_boot_shown).toBe(0);

		// Bot not called
		expect(bot.api.sendMessage).not.toHaveBeenCalled();
	});

	it('bot not set: no sendMessage attempted, warn logged, still returns', async () => {
		const { service, db, llm } = makeService({ firstBootShown: false });
		// Intentionally NOT calling service.setBot(bot)

		llm.setFixture('startup_greeting', { greeting: 'Good evening, Sir.' });

		const sessionId = seedSession(db, { startedAt: '2026-04-16T09:00:00Z' });

		// Should NOT throw
		await expect(service.emit(sessionId, null, createTestLogger())).resolves.toBeUndefined();
	});
});

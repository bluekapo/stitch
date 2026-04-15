import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp } from '../helpers/app.js';

/**
 * Phase 12 Plan 01 Task 3 — Nyquist RED integration test for logger lifecycle.
 *
 * This file INTENTIONALLY fails today. 12-02 wires:
 *   - LOG_DIR config knob honoured by createRootLogger(config)
 *   - Fastify(loggerInstance: rootLogger) instead of `logger: { level }`
 *   - Synchronous recoverOrphanedLog(config.DATA_DIR) at top of buildApp
 *   - onClose hook renaming {logDir}/stitch.log to {logDir}/stitch-{stamp}.log
 *
 * Assertions below encode the contract 12-02 must satisfy:
 *   - D-01: rename via Fastify onClose
 *   - D-05: pretty-printed log content ("hello") ends up in the rotated file
 *
 * Until 12-02 lands, this test is the acceptance signal for Wave 1.
 */

describe('D-01 + D-05: logger lifecycle (Nyquist RED — turns green in 12-02)', () => {
	let tmpDir: string;
	let priorLogDir: string | undefined;
	let priorLogLevel: string | undefined;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stitch-log-'));
		priorLogDir = process.env.LOG_DIR;
		priorLogLevel = process.env.LOG_LEVEL;
		process.env.LOG_DIR = tmpDir;
		process.env.LOG_LEVEL = 'debug';
	});

	afterEach(() => {
		if (priorLogDir === undefined) {
			delete process.env.LOG_DIR;
		} else {
			process.env.LOG_DIR = priorLogDir;
		}
		if (priorLogLevel === undefined) {
			delete process.env.LOG_LEVEL;
		} else {
			process.env.LOG_LEVEL = priorLogLevel;
		}
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	// The test budget is ≥15s because pino's file transport runs in a worker
	// thread — startup + teardown each cost a few hundred ms, and vitest's
	// default 5s leaves no headroom once you add the 100ms flush window + the
	// 100ms Pitfall 6 wait inside app.close()'s onClose hook.
	it(
		'renames stitch.log to stitch-{stamp}.log on clean close and writes "hello" through the transport',
		async () => {
			const app = buildTestApp({ LOG_LEVEL: 'debug' });

			app.log.info({ msg: 'hello' }, 'hello');

			// Give pino-pretty worker a moment to flush the line to disk.
			await new Promise((r) => setTimeout(r, 100));

			await app.close();

			// D-01 assertion: no active stitch.log left behind.
			expect(fs.existsSync(path.join(tmpDir, 'stitch.log'))).toBe(false);

			// D-01 assertion: exactly one rotated file matching the D-02 stamp shape.
			const rotated = fs
				.readdirSync(tmpDir)
				.filter((name) => /^stitch-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(-\d+)?\.log$/.test(name));
			expect(rotated.length).toBe(1);

			// D-05 assertion: pretty-printed content actually reached the file.
			const content = fs.readFileSync(path.join(tmpDir, rotated[0]), 'utf8');
			expect(content).toContain('hello');
		},
		15_000,
	);
});

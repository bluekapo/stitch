import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	formatStamp,
	parseLastLineTimestamp,
	recoverOrphanedLog,
	reqId,
} from '../../src/core/logger.js';

/**
 * Phase 12 Plan 01 Task 2 — unit tests for logger pure-function helpers.
 *
 * Covered decisions:
 * - D-02 formatStamp: NTFS-safe local-time filename stamp (no colons)
 * - D-03 recoverOrphanedLog + parseLastLineTimestamp: orphan rotation
 * - D-07 reqId: 8-char lowercase alphanumeric correlation id
 *
 * Integration of `createRootLogger` is exercised separately in
 * `test/app/logger-lifecycle.test.ts` once 12-02 wires Fastify + onClose.
 */

describe('D-02: formatStamp', () => {
	it('formats a Date as YYYY-MM-DDTHH-MM-SS with dashes (NTFS-safe)', () => {
		// Local time is timezone-dependent; assert only on shape so the test
		// runs on any CI/dev box without tz gymnastics.
		const stamp = formatStamp(new Date('2026-04-14T17:30:45.000Z'));
		expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/);
	});

	it('uses LOCAL time fields (getFullYear/getMonth/...) not UTC', () => {
		// Construct a Date with explicit local components and assert those
		// exact fields survive the formatter. Works regardless of host tz.
		const d = new Date(2026, 3, 14, 17, 30, 45); // local: 2026-04-14 17:30:45
		expect(formatStamp(d)).toBe('2026-04-14T17-30-45');
	});

	it('zero-pads single-digit months, days, hours, minutes, seconds', () => {
		const d = new Date(2026, 0, 5, 3, 2, 1); // local: 2026-01-05 03:02:01
		expect(formatStamp(d)).toBe('2026-01-05T03-02-01');
	});

	it('produces filenames with no ":" character (Windows requirement)', () => {
		const stamp = formatStamp(new Date());
		const fileName = `stitch-${stamp}.log`;
		expect(fileName).not.toContain(':');
	});
});

describe('D-03: parseLastLineTimestamp', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stitch-parse-'));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it('returns a Date from a valid pino JSON line with a numeric `time`', () => {
		const epoch = 1712345678900;
		const filePath = path.join(tmpDir, 'stitch.log');
		fs.writeFileSync(filePath, `${JSON.stringify({ level: 30, time: epoch, msg: 'hi' })}\n`);
		const parsed = parseLastLineTimestamp(filePath);
		expect(parsed).not.toBeNull();
		expect(parsed?.getTime()).toBe(epoch);
	});

	it('reads ONLY the last line when the file has multiple lines', () => {
		const firstEpoch = 1712000000000;
		const lastEpoch = 1712345678900;
		const filePath = path.join(tmpDir, 'stitch.log');
		fs.writeFileSync(
			filePath,
			`${JSON.stringify({ level: 30, time: firstEpoch, msg: 'a' })}\n${JSON.stringify({ level: 30, time: lastEpoch, msg: 'b' })}\n`,
		);
		const parsed = parseLastLineTimestamp(filePath);
		expect(parsed?.getTime()).toBe(lastEpoch);
	});

	it('returns null for unparseable content', () => {
		const filePath = path.join(tmpDir, 'stitch.log');
		fs.writeFileSync(filePath, 'not-json nonsense\n');
		expect(parseLastLineTimestamp(filePath)).toBeNull();
	});

	it('returns null for an empty file', () => {
		const filePath = path.join(tmpDir, 'stitch.log');
		fs.writeFileSync(filePath, '');
		expect(parseLastLineTimestamp(filePath)).toBeNull();
	});
});

describe('D-03: recoverOrphanedLog', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stitch-recover-'));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it('renames stitch.log to stitch-{stamp}.log using the last-line timestamp', () => {
		const epoch = new Date(2026, 3, 14, 17, 30, 45).getTime();
		const orphan = path.join(tmpDir, 'stitch.log');
		fs.writeFileSync(orphan, `${JSON.stringify({ level: 30, time: epoch, msg: 'hi' })}\n`);

		recoverOrphanedLog(tmpDir);

		expect(fs.existsSync(orphan)).toBe(false);
		const expectedName = `stitch-${formatStamp(new Date(epoch))}.log`;
		expect(fs.existsSync(path.join(tmpDir, expectedName))).toBe(true);
	});

	it('falls back to fs.statSync(mtime) when the last line is unparseable', () => {
		const orphan = path.join(tmpDir, 'stitch.log');
		fs.writeFileSync(orphan, 'garbage non-json line\n');

		const fakeMtime = new Date(2025, 11, 25, 12, 0, 0);
		fs.utimesSync(orphan, fakeMtime, fakeMtime);

		recoverOrphanedLog(tmpDir);

		expect(fs.existsSync(orphan)).toBe(false);
		const expectedName = `stitch-${formatStamp(fakeMtime)}.log`;
		expect(fs.existsSync(path.join(tmpDir, expectedName))).toBe(true);
	});

	it('falls back to mtime when the file is empty (zero bytes)', () => {
		const orphan = path.join(tmpDir, 'stitch.log');
		fs.writeFileSync(orphan, '');

		const fakeMtime = new Date(2025, 5, 1, 9, 15, 30);
		fs.utimesSync(orphan, fakeMtime, fakeMtime);

		recoverOrphanedLog(tmpDir);

		expect(fs.existsSync(orphan)).toBe(false);
		const expectedName = `stitch-${formatStamp(fakeMtime)}.log`;
		expect(fs.existsSync(path.join(tmpDir, expectedName))).toBe(true);
	});

	it('is a no-op when stitch.log is absent (no throw, no files created)', () => {
		const before = fs.readdirSync(tmpDir);
		expect(() => recoverOrphanedLog(tmpDir)).not.toThrow();
		const after = fs.readdirSync(tmpDir);
		expect(after).toEqual(before);
		expect(after.length).toBe(0);
	});

	it('appends a numeric suffix on collision (Pitfall 9 crash mid-rename)', () => {
		const epoch = new Date(2026, 3, 14, 17, 30, 45).getTime();
		const stamp = formatStamp(new Date(epoch));

		// Pre-seed the directory with the exact target filename so the
		// first rename must dodge it.
		fs.writeFileSync(path.join(tmpDir, `stitch-${stamp}.log`), 'existing\n');

		const orphan = path.join(tmpDir, 'stitch.log');
		fs.writeFileSync(orphan, `${JSON.stringify({ level: 30, time: epoch, msg: 'hi' })}\n`);

		recoverOrphanedLog(tmpDir);

		expect(fs.existsSync(orphan)).toBe(false);
		expect(fs.existsSync(path.join(tmpDir, `stitch-${stamp}.log`))).toBe(true);
		expect(fs.existsSync(path.join(tmpDir, `stitch-${stamp}-1.log`))).toBe(true);
	});
});

describe('D-07: reqId', () => {
	it('returns an 8-char lowercase alphanumeric string (no hyphens)', () => {
		const id = reqId();
		expect(id).toMatch(/^[a-z0-9]{8}$/);
	});

	it('produces 1000 distinct values across consecutive calls', () => {
		const values = new Set<string>();
		for (let i = 0; i < 1000; i += 1) {
			values.add(reqId());
		}
		expect(values.size).toBe(1000);
	});
});

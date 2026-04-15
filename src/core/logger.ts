import fs from 'node:fs';
import path from 'node:path';
import { customAlphabet } from 'nanoid/non-secure';
import pino, { type Logger } from 'pino';

/**
 * Phase 12 logger module.
 *
 * Exposes pure-function helpers plus a `createRootLogger` factory that wraps
 * pino with a pino-pretty file transport. The root logger is constructed
 * once in `buildApp` (D-09) and child-scoped per service (D-10) + per
 * interaction (D-07/D-11).
 *
 * Decision references:
 * - D-02 formatStamp: NTFS-safe `YYYY-MM-DDTHH-MM-SS` local-time filename
 * - D-03 recoverOrphanedLog: last-line pino timestamp with mtime fallback
 * - D-05 createRootLogger: pino-pretty transport to `data/logs/stitch.log`
 * - D-07 reqId: 8-char lowercase alphanumeric correlation id via nanoid
 */

const REQ_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const generateReqId = customAlphabet(REQ_ID_ALPHABET, 8);

/**
 * D-02: NTFS-safe local-time stamp for log filenames.
 * Format: `YYYY-MM-DDTHH-MM-SS` (dashes everywhere — Windows forbids `:`
 * as a path character outside the drive-letter slot).
 *
 * Uses LOCAL time (not UTC) so the user reads filenames in wall-clock.
 */
export function formatStamp(d: Date): string {
	const pad = (n: number): string => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

/**
 * D-03 helper: attempt to extract a pino `"time"` epoch-ms from the LAST
 * line of a log file. Returns `null` on any parse failure so the caller
 * can fall back to `fs.statSync(...).mtime`.
 *
 * We always write via pino-pretty so lines are NOT pure JSON — but the
 * pre-transport pino line (which some tests emit directly) or future
 * raw-JSON usage can still be parsed. On failure, `null` is returned;
 * `recoverOrphanedLog` then consults file mtime.
 */
export function parseLastLineTimestamp(filePath: string): Date | null {
	try {
		const content = fs.readFileSync(filePath, 'utf8');
		if (!content.trim()) return null;
		const lines = content.trimEnd().split('\n');
		const last = lines[lines.length - 1];
		const parsed = JSON.parse(last) as { time?: number };
		if (typeof parsed.time !== 'number') return null;
		const d = new Date(parsed.time);
		if (Number.isNaN(d.getTime())) return null;
		return d;
	} catch {
		return null;
	}
}

/**
 * D-03: if `{logDir}/{logName}` exists, rename it to
 * `{logDir}/stitch-{stamp}.log` using last-line-timestamp with mtime
 * fallback. Collision-safe via `-N` suffix (Pitfall 9: crash mid-rename).
 *
 * MUST run BEFORE pino opens the file for writing. Synchronous.
 *
 * No-op when `{logDir}/{logName}` does not exist.
 */
export function recoverOrphanedLog(logDir: string, logName = 'stitch.log'): void {
	const orphanPath = path.join(logDir, logName);
	if (!fs.existsSync(orphanPath)) return;

	let when: Date | null = parseLastLineTimestamp(orphanPath);
	if (!when) {
		try {
			when = fs.statSync(orphanPath).mtime;
		} catch {
			when = new Date();
		}
	}

	const stamp = formatStamp(when);
	let target = path.join(logDir, `stitch-${stamp}.log`);
	let counter = 0;
	while (fs.existsSync(target)) {
		counter += 1;
		target = path.join(logDir, `stitch-${stamp}-${counter}.log`);
	}
	fs.renameSync(orphanPath, target);
}

/**
 * D-07: 8-char lowercase alphanumeric correlation id. No hyphens —
 * easier to grep. Pool size 36^8 ≈ 2.8e12 is far above the Telegram
 * interaction rate for a single-user tool.
 */
export function reqId(): string {
	return generateReqId();
}

export interface CreateRootLoggerOptions {
	level: string;
	logDir: string;
	logName?: string;
}

/**
 * D-05 + D-09: build the root pino logger with a pino-pretty file
 * transport. Callers (src/app.ts) MUST call `recoverOrphanedLog` FIRST
 * so the previous session's orphan is rotated before pino opens the
 * destination.
 *
 * `colorize: false` is mandatory for file output (Pitfall 3) — ANSI
 * escapes inline in the log file make grep unreliable.
 *
 * When `level === 'silent'` (tests), skip the pino-pretty worker-thread
 * transport entirely — it costs ~hundreds of ms in startup/teardown and
 * would never receive a single line anyway. This keeps Fastify route/wake
 * test suites well under vitest's default 10s beforeEach hook budget.
 */
export function createRootLogger(options: CreateRootLoggerOptions): Logger {
	if (options.level === 'silent') {
		return pino({ level: 'silent' });
	}

	const logName = options.logName ?? 'stitch.log';
	const destination = path.join(options.logDir, logName);
	fs.mkdirSync(options.logDir, { recursive: true });

	const transport = pino.transport({
		target: 'pino-pretty',
		options: {
			destination,
			colorize: false, // Pitfall 3: never colorize a file destination
			translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
			ignore: 'pid,hostname',
			mkdir: true,
		},
	});

	return pino({ level: options.level }, transport);
}

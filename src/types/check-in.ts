/**
 * Phase 9 — trigger reason for a check-in tick (D-10).
 * Order matches the Drizzle text enum in src/db/schema.ts checkIns.triggerReason.
 */
export type TriggerReason =
	| 'scheduled'
	| 'wake'
	| 'chunk_active'
	| 'chunk_done'
	| 'task_action'
	| 'restart';

/**
 * Persisted check-in row (mirrors the Drizzle row shape from src/db/schema.ts checkIns).
 * Used for memory loading in CheckInService.runOracle prompt context (D-10).
 */
export interface CheckInRow {
	id: number;
	createdAt: string; // ISO datetime from sqlite datetime('now')
	triggerReason: TriggerReason;
	shouldSpeak: boolean;
	messageText: string | null;
	nextCheckMinutes: number | null;
	dayAnchor: string; // YYYY-MM-DD
}

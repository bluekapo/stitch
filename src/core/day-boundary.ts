import type { DayTree } from '../types/day-tree.js';

/**
 * Returns the latest HH:MM endTime across all branches in the day tree,
 * or null if the tree is undefined or empty.
 *
 * Pure function — no side effects, no DB access. Trivially unit-testable
 * with frozen tree fixtures. HH:MM strings sort lexically the same as time
 * (because zero-padded), so a string > comparison is correct.
 *
 * Usage: D-24 day boundary check in WakeStateService.isDayBoundaryCrossed.
 * If this returns null, the caller falls back to "calendar date change"
 * (midnight local) per the Pitfall 7 mitigation in 09-RESEARCH.md.
 */
export function computeLatestEndTime(tree: DayTree | undefined): string | null {
	if (!tree || tree.branches.length === 0) return null;
	let latest: string | null = null;
	for (const branch of tree.branches) {
		if (latest === null || branch.endTime > latest) {
			latest = branch.endTime;
		}
	}
	return latest;
}

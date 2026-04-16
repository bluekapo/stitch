import { z } from 'zod';
import { DayTreeLlmSchema } from './day-tree.js';

/**
 * Phase 13 (D-11, D-12) -- tree-setup conversation response.
 *
 * wrapper_text: always present, always shown to the user verbatim.
 *   Min 1 char (LLM failure mode: empty string -- we catch it upstream
 *   and retry or fail-closed). Max 2000 chars bounds Telegram
 *   message length (4096 limit, 2000 leaves headroom for
 *   quoted tree JSON in future iterations).
 *
 * propose_tree: OPTIONAL + NULLABLE.
 *   - `undefined` (field absent) -- refinement turn, TreeSetupService
 *     replies wrapper_text only, no commit.
 *   - `null` (field present, value null) -- same semantics as undefined.
 *     Pitfall 3 (RESEARCH): Qwen3.5-9B at temp 0.5 occasionally emits
 *     `"propose_tree": null` instead of omitting the key. Zod's
 *     `.optional()` rejects null; `.nullish()` accepts both.
 *   - DayTree object -- commit turn, TreeSetupService calls
 *     dayTreeService.commitProposedTree(propose_tree) after validation.
 *
 * Temperature at call site: 0.5 (per CONTEXT specifics block).
 */
export const TreeSetupResponseSchema = z.object({
	wrapper_text: z
		.string()
		.min(1)
		.max(2000)
		.describe(
			'JARVIS-voice reply shown to the user verbatim. Must be non-empty. Must not contain "!".',
		),
	propose_tree: DayTreeLlmSchema.nullish().describe(
		'Set ONLY when committing a concrete tree. Null or omitted during refinement turns.',
	),
});

export type TreeSetupResponse = z.infer<typeof TreeSetupResponseSchema>;

import { desc, isNull } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { StitchDb } from '../db/index.js';
import { conversations, sessions } from '../db/schema.js';
import {
	TREE_SETUP_HINTS,
	TREE_SETUP_MAX_HISTORY_CHARS,
	TREE_SETUP_SYSTEM_PROMPT,
	TREE_SETUP_WINDOW_ROWS,
} from '../prompts/tree-setup.js';
import { withSoul } from '../prompts/soul.js';
import type { LlmProvider } from '../providers/llm.js';
import { TreeSetupResponseSchema } from '../schemas/tree-setup.js';
import type { DayTreeService } from './day-tree-service.js';

// Re-export constants so callers (and tests) can import from a single module.
export { TREE_SETUP_HINTS, TREE_SETUP_MAX_HISTORY_CHARS, TREE_SETUP_WINDOW_ROWS };

/**
 * Phase 13 -- TreeSetupService (D-11, D-12, D-13, D-18).
 *
 * Constructor follows the CheckInService options-object pattern (Pitfall 5).
 *
 * propose() is the single public method. Flow:
 *   1. (sync DB) Write user's text as conversations row BEFORE LLM call so
 *      the next propose() turn sees it in history.
 *   2. (sync DB) Read the last TREE_SETUP_WINDOW_ROWS conversations rows,
 *      trim by char budget, serialize to user prompt.
 *   3. (async LLM, temp 0.5, thinking false) -- Pitfall 4: LLM runs OUTSIDE
 *      any transaction.
 *   4. (sync DB) If propose_tree is a real DayTree, commitProposedTree(tree);
 *      if null/undefined, skip commit.
 *   5. (sync DB) Write assistant conversations row with wrapper_text.
 *
 * Steps 4-5 are wrapped in db.transaction() for atomicity -- if commitProposedTree
 * throws, the assistant row is NOT written.
 */
export interface TreeSetupServiceOptions {
	db: StitchDb;
	llmProvider: LlmProvider;
	dayTreeService: DayTreeService;
	logger: Logger;
}

export class TreeSetupService {
	private readonly db: StitchDb;
	private readonly llmProvider: LlmProvider;
	private readonly dayTreeService: DayTreeService;
	private readonly logger: Logger;

	constructor(opts: TreeSetupServiceOptions) {
		this.db = opts.db;
		this.llmProvider = opts.llmProvider;
		this.dayTreeService = opts.dayTreeService;
		this.logger = opts.logger;
	}

	async propose(
		userText: string,
		reqLogger?: Logger,
	): Promise<{ wrapper_text: string; committed: boolean }> {
		const log = reqLogger ?? this.logger;
		log.debug({ userTextLen: userText.length }, 'treeSetup.propose:start');

		// 1. Resolve current session id (for FK on writes).
		const sessionId = this.resolveCurrentSessionId();

		// 2. Write user turn BEFORE LLM call (Pitfall 5: ordering).
		this.db
			.insert(conversations)
			.values({
				sessionId: sessionId ?? 0,
				role: 'user',
				content: userText,
				classifierIntent: 'tree_setup',
				triggeredBy: null,
			})
			.run();

		// 3. Build user prompt with windowed + trimmed conversation history.
		const tree = this.dayTreeService.getTree();
		const historyLines = this.readConversationHistoryAsLines();
		const userPrompt = [
			`Current tree: ${tree ? JSON.stringify(tree) : '<not set>'}`,
			'',
			'Conversation history (most recent last):',
			...historyLines,
			'',
			`Latest user message: ${userText}`,
		].join('\n');

		log.debug(
			{ historyLineCount: historyLines.length, promptChars: userPrompt.length },
			'treeSetup.propose:prompt-built',
		);

		// 4. LLM call (Pitfall 4: async, OUTSIDE transaction).
		const result = await this.llmProvider.complete({
			messages: [
				{ role: 'system', content: withSoul(TREE_SETUP_SYSTEM_PROMPT) },
				{ role: 'user', content: userPrompt },
			],
			schema: TreeSetupResponseSchema,
			schemaName: 'tree_setup_response',
			temperature: 0.5,
			maxTokens: 1024,
			thinking: false,
		});

		log.debug(
			{
				wrapperLen: result.wrapper_text.length,
				hasProposal: result.propose_tree != null,
			},
			'treeSetup.propose:llm-ok',
		);

		// 5. Commit + write assistant row (Pitfall 3: nullish covers both null and undefined).
		const committed = result.propose_tree != null;

		// Wrap steps 5-6 in transaction for atomicity: if commitProposedTree throws,
		// the assistant row is NOT written.
		this.db.transaction(() => {
			if (committed && result.propose_tree) {
				this.dayTreeService.commitProposedTree(result.propose_tree, log);
			}

			// D-16: 'tree_setup_reply' when no commit on this turn; 'tree_confirm_reply' when committed.
			this.db
				.insert(conversations)
				.values({
					sessionId: sessionId ?? 0,
					role: 'assistant',
					content: result.wrapper_text,
					classifierIntent: null,
					triggeredBy: committed ? 'tree_confirm_reply' : 'tree_setup_reply',
				})
				.run();
		});

		log.debug({ committed }, 'treeSetup.propose:done');
		return { wrapper_text: result.wrapper_text, committed };
	}

	/** Latest open session's id, or null if none (defensive -- app.ts always starts one). */
	private resolveCurrentSessionId(): number | null {
		const row = this.db
			.select({ id: sessions.id })
			.from(sessions)
			.where(isNull(sessions.endedAt))
			.orderBy(desc(sessions.id))
			.limit(1)
			.get();
		return row?.id ?? null;
	}

	/**
	 * Read last N conversations rows, reverse to chronological order, trim
	 * from oldest until total char length <= TREE_SETUP_MAX_HISTORY_CHARS.
	 * Returns array of "User: ..." / "Stitch: ..." strings.
	 */
	private readConversationHistoryAsLines(): string[] {
		const rows = this.db
			.select({
				role: conversations.role,
				content: conversations.content,
			})
			.from(conversations)
			.orderBy(desc(conversations.createdAt), desc(conversations.id))
			.limit(TREE_SETUP_WINDOW_ROWS)
			.all();

		// Reverse to chronological (oldest first).
		const chronological = rows.reverse();

		// Format.
		const formatted = chronological.map((r) =>
			r.role === 'user' ? `User: ${r.content}` : `Stitch: ${r.content}`,
		);

		// Trim from oldest until char budget fits.
		let totalChars = formatted.reduce((acc, line) => acc + line.length + 1, 0); // +1 for newline
		while (totalChars > TREE_SETUP_MAX_HISTORY_CHARS && formatted.length > 0) {
			const dropped = formatted.shift();
			if (dropped) totalChars -= dropped.length + 1;
		}

		return formatted;
	}
}

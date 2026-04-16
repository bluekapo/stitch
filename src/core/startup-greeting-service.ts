/**
 * Phase 13 -- StartupGreetingService.
 *
 * Fires ONCE per boot from buildApp onReady (fire-and-forget). Composes
 * three state flags:
 *   - first_ever: settings.first_boot_shown === false
 *   - just_back_online: lastEndAt !== null
 *   - tree_missing: dayTreeService.getTree() === undefined
 *
 * Calls Qwen with temp 0.7 / thinking: false, validates with
 * GreetingResponseSchema (3-layer "no !" defense), sends Telegram,
 * writes a conversations row, flips settings.first_boot_shown on first ever.
 *
 * Pitfall 4: Keep sync DB writes OUTSIDE any await. We await the LLM,
 * THEN do the SQL writes sync.
 *
 * Pitfall 5: Options-object constructor because 6 deps (6 >= 5).
 */
import { eq } from 'drizzle-orm';
import type { Bot } from 'grammy';
import type { Logger } from 'pino';
import type { StitchContext } from '../channels/telegram/types.js';
import type { StitchDb } from '../db/index.js';
import { conversations, settings } from '../db/schema.js';
import { formatGap, GREETER_SYSTEM_PROMPT, GreetingResponseSchema } from '../prompts/greeter.js';
import { withSoul } from '../prompts/soul.js';
import type { LlmProvider } from '../providers/llm.js';
import type { DayTreeService } from './day-tree-service.js';

// Re-export formatGap so existing test imports from this module keep working.
export { formatGap } from '../prompts/greeter.js';

export interface StartupGreetingServiceOptions {
	db: StitchDb;
	llmProvider: LlmProvider;
	dayTreeService: DayTreeService;
	logger: Logger;
	userChatId?: number;
	bot?: Bot<StitchContext>;
	now?: () => Date;
}

export class StartupGreetingService {
	private readonly db: StitchDb;
	private readonly llmProvider: LlmProvider;
	private readonly dayTreeService: DayTreeService;
	private readonly logger: Logger;
	private readonly userChatId: number | undefined;
	private bot: Bot<StitchContext> | undefined;
	private readonly nowFn: () => Date;

	constructor(opts: StartupGreetingServiceOptions) {
		this.db = opts.db;
		this.llmProvider = opts.llmProvider;
		this.dayTreeService = opts.dayTreeService;
		this.logger = opts.logger;
		this.userChatId = opts.userChatId;
		this.bot = opts.bot;
		this.nowFn = opts.now ?? (() => new Date());
	}

	setBot(bot: Bot<StitchContext> | undefined): void {
		this.bot = bot;
	}

	async emit(sessionId: number, lastEndAt: Date | null, reqLogger?: Logger): Promise<void> {
		const log = reqLogger ?? this.logger;
		const now = this.nowFn();

		// 1) Gather state.
		const settingsRow = this.db
			.select({ firstBootShown: settings.firstBootShown })
			.from(settings)
			.where(eq(settings.id, 1))
			.get();
		const firstEver = settingsRow ? !settingsRow.firstBootShown : false;
		const justBackOnline = lastEndAt !== null;
		const treeMissing = this.dayTreeService.getTree() === undefined;
		const gap = formatGap(lastEndAt, now);

		log.debug({ sessionId, firstEver, justBackOnline, treeMissing, gap }, 'greeter.emit:state');

		// Early exit: no chat id means no user to send to.
		if (this.userChatId === undefined) {
			log.debug('greeter.emit:no-chat-id -- skipping');
			return;
		}

		// 2) Compose user prompt (pure state block, no free text).
		const weekday = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][
			now.getDay()
		];
		const hh = String(now.getHours()).padStart(2, '0');
		const mm = String(now.getMinutes()).padStart(2, '0');
		const userPrompt = [
			'State flags:',
			`- first_ever: ${firstEver}`,
			`- just_back_online: ${justBackOnline}`,
			`- tree_missing: ${treeMissing}`,
			`- gap: "${gap}"`,
			`- now: "${weekday} ${hh}:${mm}"`,
		].join('\n');

		// 3) LLM call (OUTSIDE any DB transaction -- Pitfall 4).
		let greeting: string;
		try {
			const result = await this.llmProvider.complete({
				messages: [
					{ role: 'system', content: withSoul(GREETER_SYSTEM_PROMPT) },
					{ role: 'user', content: userPrompt },
				],
				schema: GreetingResponseSchema,
				schemaName: 'startup_greeting',
				temperature: 0.7,
				maxTokens: 256,
				thinking: false,
			});
			greeting = result.greeting;
		} catch (err) {
			log.warn({ err }, 'greeter.emit:llm-failed');
			return; // Fail-closed. No Telegram send, no DB write.
		}

		log.debug({ length: greeting.length }, 'greeter.emit:llm-ok');

		// 4) Send to Telegram (skip when bot is not set).
		if (this.bot) {
			try {
				await this.bot.api.sendMessage(this.userChatId, greeting);
			} catch (err) {
				// Telegram down or user blocked the bot -- log and continue so we
				// still persist the greeting to conversations (D-17 keep-forever).
				log.warn({ err }, 'greeter.emit:telegram-send-failed');
			}
		} else {
			log.debug('greeter.emit:no-bot -- skipping send');
		}

		// 5) Persist + flip first_boot_shown (sync writes; safe to group).
		// Write conversations row per D-16: role='assistant', content=greeting,
		// triggered_by = whichever state flag dominates (first_ever > tree_missing > back_online
		// per D-07 composite rule), classifier_intent = null (assistant row).
		const triggeredBy: 'first_ever' | 'tree_missing' | 'back_online' = firstEver
			? 'first_ever'
			: treeMissing
				? 'tree_missing'
				: 'back_online';
		this.db
			.insert(conversations)
			.values({
				sessionId,
				role: 'assistant',
				content: greeting,
				classifierIntent: null,
				triggeredBy,
			})
			.run();

		if (firstEver) {
			this.db.update(settings).set({ firstBootShown: true }).where(eq(settings.id, 1)).run();
			log.debug('greeter.emit:first-boot-flipped');
		}

		log.debug({ sessionId }, 'greeter.emit:done');
	}
}

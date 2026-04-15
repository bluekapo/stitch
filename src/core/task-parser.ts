import type { Logger } from 'pino';
import type { LlmProvider } from '../providers/llm.js';
import { type TaskParseResult, TaskParseSchema } from '../schemas/task-parse.js';

export class TaskParserService {
	// D-12: `logger` REQUIRED.
	constructor(
		private llm: LlmProvider,
		private logger: Logger,
	) {}

	async parse(userInput: string, reqLogger?: Logger): Promise<TaskParseResult> {
		const log = reqLogger ?? this.logger;
		log.debug({ userInput }, 'taskParser.parse:start');
		const result = await this.llm.complete({
			messages: [
				{
					role: 'system',
					content: `You parse natural language into structured task data. Today is ${new Date().toISOString().split('T')[0]}.

Rules:
- name: concise, 1-5 words
- taskType: "daily" if user says "every day"/"daily"/"each day". "weekly" if user says "every Monday"/"weekly"/"each week". "one-time" if a specific date/deadline is given. "ad-hoc" only if none of the above apply.
- deadline: ISO 8601 datetime, only for one-time tasks with a specific date/time
- recurrenceDay: only for weekly tasks (0=Sunday..6=Saturday)
- isEssential: true ONLY if user explicitly says must-do/essential/locked`,
				},
				{ role: 'user', content: userInput },
			],
			schema: TaskParseSchema,
			schemaName: 'task_parse',
			temperature: 0.1,
			maxTokens: 256,
			thinking: false,
		});
		log.debug({ name: result.name, taskType: result.taskType }, 'taskParser.parse:done');
		return result;
	}
}

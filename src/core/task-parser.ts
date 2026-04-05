import type { LlmProvider } from '../providers/llm.js';
import { TaskParseSchema, type TaskParseResult } from '../schemas/task-parse.js';

export class TaskParserService {
	constructor(private llm: LlmProvider) {}

	async parse(userInput: string): Promise<TaskParseResult> {
		return this.llm.complete({
			messages: [
				{
					role: 'system',
					content: `/no_think\nYou parse natural language into structured task data. Today is ${new Date().toISOString().split('T')[0]}. Extract the task name (concise, 1-5 words), determine task type, extract deadline if mentioned (as ISO 8601), identify recurrence pattern if mentioned. Default to ad-hoc if no recurrence or deadline. Only mark isEssential=true if user explicitly says must-do/essential/locked.`,
				},
				{ role: 'user', content: userInput },
			],
			schema: TaskParseSchema,
			schemaName: 'task_parse',
			temperature: 0.1,
			maxTokens: 256,
		});
	}
}

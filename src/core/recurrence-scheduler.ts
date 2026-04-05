import { CronJob } from 'cron';
import type { TaskService } from './task-service.js';

export class RecurrenceScheduler {
	private dailyJob: CronJob;

	constructor(
		private taskService: TaskService,
		cronTime: string = '0 5 * * *',
	) {
		this.dailyJob = CronJob.from({
			cronTime,
			onTick: () => this.generateAll(),
			start: false,
		});
	}

	start(): void {
		this.dailyJob.start();
	}

	stop(): void {
		this.dailyJob.stop();
	}

	/** Generate all recurring task instances for today. Idempotent. */
	generateAll(): void {
		this.generateDailyTasks();
		this.generateWeeklyTasks();
	}

	generateDailyTasks(): number {
		const today = new Date().toISOString().split('T')[0];
		const templates = this.taskService.getRecurringTemplates('daily');
		let created = 0;
		for (const template of templates) {
			if (!this.taskService.hasInstanceForDate(template.id, today)) {
				this.taskService.createInstance(template, today);
				created++;
			}
		}
		return created;
	}

	generateWeeklyTasks(): number {
		const now = new Date();
		const dayOfWeek = now.getDay(); // 0=Sunday
		const today = now.toISOString().split('T')[0];
		const templates = this.taskService
			.getRecurringTemplates('weekly')
			.filter(t => t.recurrenceDay === dayOfWeek);
		let created = 0;
		for (const template of templates) {
			if (!this.taskService.hasInstanceForDate(template.id, today)) {
				this.taskService.createInstance(template, today);
				created++;
			}
		}
		return created;
	}
}

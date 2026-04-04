import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const tasks = sqliteTable('tasks', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	name: text('name').notNull(),
	description: text('description'),
	status: text('status', {
		enum: ['pending', 'active', 'completed', 'skipped'],
	})
		.notNull()
		.default('pending'),
	isEssential: integer('is_essential', { mode: 'boolean' })
		.notNull()
		.default(false),
	postponeCount: integer('postpone_count').notNull().default(0),
	timerStartedAt: text('timer_started_at'),
	createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
	updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
});

export const taskDurations = sqliteTable('task_durations', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	taskId: integer('task_id')
		.notNull()
		.references(() => tasks.id, { onDelete: 'cascade' }),
	durationSeconds: integer('duration_seconds').notNull(),
	startedAt: text('started_at').notNull(),
	endedAt: text('ended_at').notNull().default(sql`(datetime('now'))`),
});

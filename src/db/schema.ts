import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { DayTree } from '../types/day-tree.js';

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
	taskType: text('task_type', {
		enum: ['one-time', 'daily', 'weekly', 'ad-hoc'],
	}).notNull().default('ad-hoc'),
	recurrenceDay: integer('recurrence_day'),
	deadline: text('deadline'),
	sourceTaskId: integer('source_task_id'), // FK to tasks.id (self-ref, enforced in DDL)
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

export const blueprints = sqliteTable('blueprints', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	name: text('name').notNull(),
	isActive: integer('is_active', { mode: 'boolean' }).notNull().default(false),
	createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
	updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
});

export const blueprintCycles = sqliteTable('blueprint_cycles', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	blueprintId: integer('blueprint_id').notNull()
		.references(() => blueprints.id, { onDelete: 'cascade' }),
	name: text('name').notNull(),
	sortOrder: integer('sort_order').notNull().default(0),
	startTime: text('start_time').notNull(),
	endTime: text('end_time').notNull(),
});

export const blueprintTimeBlocks = sqliteTable('blueprint_time_blocks', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	cycleId: integer('cycle_id').notNull()
		.references(() => blueprintCycles.id, { onDelete: 'cascade' }),
	label: text('label'),
	startTime: text('start_time').notNull(),
	endTime: text('end_time').notNull(),
	isSlot: integer('is_slot', { mode: 'boolean' }).notNull().default(true),
	sortOrder: integer('sort_order').notNull().default(0),
});

export const dayTrees = sqliteTable('day_trees', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	tree: text('tree', { mode: 'json' }).$type<DayTree>().notNull(),
	createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
	updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
});

export const dailyPlans = sqliteTable('daily_plans', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	date: text('date').notNull().unique(),
	blueprintId: integer('blueprint_id').notNull()
		.references(() => blueprints.id),
	status: text('status', {
		enum: ['active', 'completed', 'cancelled'],
	}).notNull().default('active'),
	llmReasoning: text('llm_reasoning'),
	createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

export const planChunks = sqliteTable('plan_chunks', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	planId: integer('plan_id').notNull()
		.references(() => dailyPlans.id, { onDelete: 'cascade' }),
	taskId: integer('task_id')
		.references(() => tasks.id, { onDelete: 'set null' }),
	label: text('label').notNull(),
	startTime: text('start_time').notNull(),
	endTime: text('end_time').notNull(),
	isLocked: integer('is_locked', { mode: 'boolean' }).notNull().default(false),
	sortOrder: integer('sort_order').notNull().default(0),
	status: text('status', {
		enum: ['pending', 'active', 'completed', 'skipped'],
	}).notNull().default('pending'),
});

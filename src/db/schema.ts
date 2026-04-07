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
	// Phase 08.3: direct task->chunk attachment + denormalized branch name.
	// Both nullable. chunk_id FK uses ON DELETE SET NULL so regenerating a plan
	// (which deletes old chunks) drops stale references instead of orphaning rows.
	chunkId: integer('chunk_id'), // FK to plan_chunks.id ON DELETE SET NULL (enforced in DDL)
	branchName: text('branch_name'),
	createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
	updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
});

export const taskDurations = sqliteTable('task_durations', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	taskId: integer('task_id')
		.notNull()
		.references(() => tasks.id, { onDelete: 'cascade' }),
	// Phase 10 (D-22): nullable — skip/postpone rows carry no real duration.
	durationSeconds: integer('duration_seconds'),
	// Phase 10 (D-22): outcome discriminator. 'completed' = stopTimer wrote this row,
	// 'skipped' = taskService.skip wrote this row, 'postponed' = taskService.postpone wrote this row.
	outcome: text('outcome', {
		enum: ['completed', 'skipped', 'postponed'],
	})
		.notNull()
		.default('completed'),
	// Phase 10 (D-21, D-23): prediction snapshot at write time — full range + confidence.
	// Copied from the active chunk_tasks row by taskService.stopTimer/skip/postpone.
	// Nullable because rows from before Phase 10 have no predictions.
	predictedMinSeconds: integer('predicted_min_seconds'),
	predictedMaxSeconds: integer('predicted_max_seconds'),
	predictedConfidence: text('predicted_confidence', {
		enum: ['low', 'medium', 'high'],
	}),
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
	blueprintId: integer('blueprint_id')
		.references(() => blueprints.id),
	dayTreeId: integer('day_tree_id')
		.references(() => dayTrees.id),
	status: text('status', {
		enum: ['active', 'completed', 'cancelled'],
	}).notNull().default('active'),
	llmReasoning: text('llm_reasoning'),
	// Phase 9 (D-19): wake state tracking — all nullable, idempotency leaves null until first wake call.
	startedAt: text('started_at'),
	lastWakeCallAt: text('last_wake_call_at'),
	wakeFiredAt: text('wake_fired_at'),
	createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

export const planChunks = sqliteTable('plan_chunks', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	planId: integer('plan_id').notNull()
		.references(() => dailyPlans.id, { onDelete: 'cascade' }),
	taskId: integer('task_id')
		.references(() => tasks.id, { onDelete: 'set null' }),
	branchName: text('branch_name').notNull().default(''),
	label: text('label').notNull(),
	startTime: text('start_time').notNull(),
	endTime: text('end_time').notNull(),
	isLocked: integer('is_locked', { mode: 'boolean' }).notNull().default(false),
	isTaskSlot: integer('is_task_slot', { mode: 'boolean' }).notNull().default(true),
	sortOrder: integer('sort_order').notNull().default(0),
	status: text('status', {
		enum: ['pending', 'active', 'completed', 'skipped'],
	}).notNull().default('pending'),
});

export const chunkTasks = sqliteTable('chunk_tasks', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	chunkId: integer('chunk_id').notNull()
		.references(() => planChunks.id, { onDelete: 'cascade' }),
	taskId: integer('task_id')
		.references(() => tasks.id, { onDelete: 'set null' }),
	label: text('label').notNull(),
	isLocked: integer('is_locked', { mode: 'boolean' }).notNull().default(false),
	sortOrder: integer('sort_order').notNull().default(0),
	status: text('status', {
		enum: ['pending', 'active', 'completed', 'skipped'],
	}).notNull().default('pending'),
	// Phase 10 (D-05): live prediction storage. Populated by DailyPlanService.generatePlan
	// after the prediction LLM call resolves. Nullable for D-06 fall-through cases
	// (prediction LLM failed twice → null columns → display layer omits the suffix).
	predictedMinSeconds: integer('predicted_min_seconds'),
	predictedMaxSeconds: integer('predicted_max_seconds'),
	predictedConfidence: text('predicted_confidence', {
		enum: ['low', 'medium', 'high'],
	}),
});

export const pendingCleanups = sqliteTable('pending_cleanups', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	chatId: integer('chat_id').notNull(),
	userMsgId: integer('user_msg_id').notNull(),
	replyMsgId: integer('reply_msg_id'),
	deleteAfter: text('delete_after').notNull(),
});

// Phase 9 (D-10): check_ins table — separate from pending_cleanups (D-12 separation).
// trigger_reason enum order is FIXED — do not reorder or add values without a migration.
export const checkIns = sqliteTable('check_ins', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
	triggerReason: text('trigger_reason', {
		enum: ['scheduled', 'wake', 'chunk_active', 'chunk_done', 'task_action', 'restart'],
	}).notNull(),
	shouldSpeak: integer('should_speak', { mode: 'boolean' }).notNull(),
	messageText: text('message_text'),
	nextCheckMinutes: integer('next_check_minutes'),
	dayAnchor: text('day_anchor').notNull(),
});

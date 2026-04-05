import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { tasks } from '../../src/db/schema.js';
import { createTestDb } from '../helpers/db.js';

type TestDb = ReturnType<typeof createTestDb>;

describe('tasks table -- CRUD operations', () => {
	let db: TestDb;

	it('createTestDb() returns a Drizzle instance that can execute queries', () => {
		db = createTestDb();
		const result = db.select().from(tasks).all();
		expect(result).toEqual([]);
	});

	it('insert a task with name "Buy groceries", select it back, verify name matches', () => {
		db = createTestDb();
		db.insert(tasks).values({ name: 'Buy groceries' }).run();

		const rows = db.select().from(tasks).all();
		expect(rows).toHaveLength(1);
		expect(rows[0].name).toBe('Buy groceries');
	});

	it('insert a task, update its status to "completed", verify status is "completed"', () => {
		db = createTestDb();
		db.insert(tasks).values({ name: 'Do laundry' }).run();

		const inserted = db.select().from(tasks).all();
		const taskId = inserted[0].id;

		db.update(tasks).set({ status: 'completed' }).where(eq(tasks.id, taskId)).run();

		const updated = db.select().from(tasks).where(eq(tasks.id, taskId)).all();
		expect(updated[0].status).toBe('completed');
	});

	it('insert a task, verify createdAt and updatedAt are auto-populated with ISO datetime strings', () => {
		db = createTestDb();
		db.insert(tasks).values({ name: 'Check timestamps' }).run();

		const rows = db.select().from(tasks).all();
		expect(rows[0].createdAt).toBeTruthy();
		expect(rows[0].updatedAt).toBeTruthy();

		// SQLite datetime('now') returns 'YYYY-MM-DD HH:MM:SS' format
		const dateTimePattern = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
		expect(rows[0].createdAt).toMatch(dateTimePattern);
		expect(rows[0].updatedAt).toMatch(dateTimePattern);
	});

	it('default status is "pending"', () => {
		db = createTestDb();
		db.insert(tasks).values({ name: 'Check default status' }).run();

		const rows = db.select().from(tasks).all();
		expect(rows[0].status).toBe('pending');
	});

	it('id auto-increments', () => {
		db = createTestDb();
		db.insert(tasks).values({ name: 'Task A' }).run();
		db.insert(tasks).values({ name: 'Task B' }).run();

		const rows = db.select().from(tasks).all();
		expect(rows).toHaveLength(2);
		expect(rows[0].id).toBe(1);
		expect(rows[1].id).toBe(2);
	});
});

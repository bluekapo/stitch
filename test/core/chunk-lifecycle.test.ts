import { format } from 'date-fns';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { CheckInService } from '../../src/core/check-in-service.js';
import { DailyPlanService } from '../../src/core/daily-plan-service.js';
import { DayTreeService } from '../../src/core/day-tree-service.js';
import { PredictionService } from '../../src/core/prediction-service.js';
import { TaskService } from '../../src/core/task-service.js';
import { dailyPlans, planChunks, tasks } from '../../src/db/schema.js';
import { MockLlmProvider } from '../../src/providers/mock.js';
import { createTestDb } from '../helpers/db.js';

const TODAY = format(new Date(), 'yyyy-MM-dd');

function makeService(now?: () => Date) {
	const db = createTestDb();
	const llm = new MockLlmProvider();
	const dayTreeService = new DayTreeService(db, llm);
	const taskService = new TaskService(db);
	const predictionService = new PredictionService(db, taskService, dayTreeService, llm);
	const dailyPlanService = new DailyPlanService(
		db,
		dayTreeService,
		taskService,
		llm,
		predictionService,
	);
	const service = new CheckInService({
		llmProvider: llm,
		dayTreeService,
		taskService,
		dailyPlanService,
		db,
		userChatId: 100,
		cleanupTtlMs: 900_000,
		now,
	});
	return { service, db, llm, dayTreeService, taskService };
}

function seedPlanWithChunk(db: ReturnType<typeof createTestDb>) {
	// Insert a daily plan + one chunk + 2 attached tasks
	db.insert(dailyPlans)
		.values({
			date: TODAY,
			status: 'active',
		})
		.run();
	const planRow = db.select().from(dailyPlans).all()[0];

	db.insert(planChunks)
		.values({
			planId: planRow.id,
			branchName: 'Morning',
			label: 'Morning duties',
			startTime: '08:00',
			endTime: '10:00',
			isTaskSlot: true,
			sortOrder: 0,
			status: 'pending',
		})
		.run();
	const chunkRow = db.select().from(planChunks).all()[0];

	db.insert(tasks).values({ name: 'Pushups', chunkId: chunkRow.id, branchName: 'Morning' }).run();
	db.insert(tasks).values({ name: 'Read', chunkId: chunkRow.id, branchName: 'Morning' }).run();

	return chunkRow.id;
}

describe('CheckInService.runBufferEndDisposition (PLAN-05)', () => {
	it('buffer end -- transitions chunk status to skipped when LLM skips all tasks', async () => {
		const { service, db, llm } = makeService();
		const chunkId = seedPlanWithChunk(db);
		const taskRows = db.select().from(tasks).all();

		llm.setFixture('buffer_end_disposition', {
			decisions: [
				{ taskId: taskRows[0].id, action: 'skip' },
				{ taskId: taskRows[1].id, action: 'skip' },
			],
		});

		await service.runBufferEndDisposition(chunkId);

		const updatedChunk = db.select().from(planChunks).where(eq(planChunks.id, chunkId)).get();
		expect(updatedChunk?.status).toBe('skipped');
		const updatedTasks = db.select().from(tasks).all();
		expect(updatedTasks.every((t) => t.status === 'skipped')).toBe(true);
	});

	it('atomicity -- LLM call dispatches BEFORE db.transaction opens (Pitfall 4 regression guard)', async () => {
		const { service, db, llm } = makeService();
		const chunkId = seedPlanWithChunk(db);
		const taskRows = db.select().from(tasks).all();

		const completeSpy = vi.spyOn(llm, 'complete').mockImplementation(async () => {
			// The crucial assertion: when this LLM call runs, the chunk must STILL be 'pending'
			// (i.e., db.transaction has NOT yet been opened). If the await were INSIDE the
			// transaction, by this point the busy-lock would prevent any subsequent reads.
			const chunkBefore = db.select().from(planChunks).where(eq(planChunks.id, chunkId)).get();
			expect(chunkBefore?.status).toBe('pending');
			return {
				decisions: [
					{ taskId: taskRows[0].id, action: 'continue' as const },
					{ taskId: taskRows[1].id, action: 'continue' as const },
				],
			};
		});

		await service.runBufferEndDisposition(chunkId);
		expect(completeSpy).toHaveBeenCalled();

		// After disposition with all 'continue', tasks remain pending — chunk should still be 'skipped'
		// (because still-active tasks remain). Verify the transaction completed without error.
		const after = db.select().from(planChunks).where(eq(planChunks.id, chunkId)).get();
		expect(after?.status).toBe('skipped'); // 2 tasks still pending → not 'completed'
	});

	it('skip -- skipped chunk persists with status=skipped; pending tasks dispositioned', async () => {
		const { service, db, llm } = makeService();
		const chunkId = seedPlanWithChunk(db);
		const taskRows = db.select().from(tasks).all();

		llm.setFixture('buffer_end_disposition', {
			decisions: [
				{ taskId: taskRows[0].id, action: 'postpone' },
				{ taskId: taskRows[1].id, action: 'skip' },
			],
		});

		await service.runBufferEndDisposition(chunkId);

		const updatedChunk = db.select().from(planChunks).where(eq(planChunks.id, chunkId)).get();
		expect(updatedChunk?.status).toBe('skipped');

		const t1 = db.select().from(tasks).where(eq(tasks.id, taskRows[0].id)).get();
		expect(t1?.status).toBe('pending');
		expect(t1?.postponeCount).toBe(1);
		expect(t1?.chunkId).toBeNull(); // Pitfall 6: postpone nulls chunkId

		const t2 = db.select().from(tasks).where(eq(tasks.id, taskRows[1].id)).get();
		expect(t2?.status).toBe('skipped');
	});

	it('completed transition -- chunk transitions to completed when no pending/active tasks remain', async () => {
		const { service, db, llm } = makeService();
		const chunkId = seedPlanWithChunk(db);
		const taskRows = db.select().from(tasks).all();
		// Pre-mark both tasks as completed
		db.update(tasks).set({ status: 'completed' }).where(eq(tasks.id, taskRows[0].id)).run();
		db.update(tasks).set({ status: 'completed' }).where(eq(tasks.id, taskRows[1].id)).run();

		llm.setFixture('buffer_end_disposition', {
			decisions: [
				{ taskId: taskRows[0].id, action: 'continue' },
				{ taskId: taskRows[1].id, action: 'continue' },
			],
		});

		await service.runBufferEndDisposition(chunkId);

		const updatedChunk = db.select().from(planChunks).where(eq(planChunks.id, chunkId)).get();
		expect(updatedChunk?.status).toBe('completed');
	});

	it('empty chunk -- chunk with no tasks transitions to completed without LLM call', async () => {
		const { service, db, llm } = makeService();
		// Insert an empty chunk
		db.insert(dailyPlans).values({ date: TODAY, status: 'active' }).run();
		const planRow = db.select().from(dailyPlans).all()[0];
		db.insert(planChunks)
			.values({
				planId: planRow.id,
				branchName: 'Empty',
				label: 'Empty',
				startTime: '12:00',
				endTime: '13:00',
				isTaskSlot: true,
				sortOrder: 0,
				status: 'pending',
			})
			.run();
		const chunkId = db.select().from(planChunks).all()[0].id;

		const completeSpy = vi.spyOn(llm, 'complete');
		await service.runBufferEndDisposition(chunkId);

		expect(completeSpy).not.toHaveBeenCalled();
		const updatedChunk = db.select().from(planChunks).where(eq(planChunks.id, chunkId)).get();
		expect(updatedChunk?.status).toBe('completed');
	});

	it('tick dispatches buffer-end disposition past 50% buffer (Warning 6 wiring guard)', async () => {
		// The fixed instant `now` exists ENTIRELY past the buffer window for the seeded
		// 08:00-10:00 chunk: end=10:00, buffer = 1h, bufferEnd = 11:00. Pick now=11:30 → past.
		const mockNow = new Date(`${TODAY}T11:30:00`);
		const { service, db, llm } = makeService(() => mockNow);

		// Seed plan + chunk + 2 pending tasks via the same helper.
		const chunkId = seedPlanWithChunk(db);
		// Mark plan as started so tick() considers it active (recomputeFromLastCheckIn path).
		db.update(dailyPlans)
			.set({ startedAt: `${TODAY}T08:00:00` })
			.run();
		const taskRows = db.select().from(tasks).all();

		llm.setFixture('buffer_end_disposition', {
			decisions: [
				{ taskId: taskRows[0].id, action: 'skip' },
				{ taskId: taskRows[1].id, action: 'skip' },
			],
		});

		// Drive the lifecycle through `tick()` (NOT a direct runBufferEndDisposition call).
		// This is the critical assertion: tick() must wire dispatch to runBufferEndDisposition.
		await service.tick();

		const chunkAfter = db.select().from(planChunks).where(eq(planChunks.id, chunkId)).get();
		expect(chunkAfter?.status).toBe('skipped');
		const tasksAfter = db.select().from(tasks).all();
		expect(tasksAfter.every((t) => t.status === 'skipped')).toBe(true);
	});
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Bot } from 'grammy';
import type { StitchContext } from '../../src/channels/telegram/types.js';
import { renderBlueprintView, renderBlueprintListText } from '../../src/channels/telegram/views.js';
import { registerBlueprintHandlers } from '../../src/channels/telegram/handlers/blueprint-handler.js';
import type { FullBlueprint } from '../../src/types/blueprint.js';

// --- View renderer tests ---

describe('renderBlueprintView', () => {
	const makeBlueprint = (overrides: Partial<FullBlueprint> = {}): FullBlueprint => ({
		id: 1,
		name: 'Weekday',
		isActive: true,
		cycles: [
			{
				id: 1,
				name: 'Morning',
				startTime: '07:00',
				endTime: '12:00',
				sortOrder: 0,
				timeBlocks: [
					{ id: 1, label: 'Shower', startTime: '07:00', endTime: '07:30', isSlot: false, sortOrder: 0 },
					{ id: 2, label: null, startTime: '08:00', endTime: '09:00', isSlot: true, sortOrder: 1 },
				],
			},
		],
		...overrides,
	});

	it('renders blueprint name in bold with <b> tags', () => {
		const result = renderBlueprintView(makeBlueprint());
		expect(result).toContain('<b>-- Blueprint: Weekday --</b>');
	});

	it('renders each cycle name with start-end time range', () => {
		const result = renderBlueprintView(makeBlueprint());
		expect(result).toContain('<b>Morning</b> (07:00-12:00)');
	});

	it('renders time blocks with white square icon for isSlot=true', () => {
		const result = renderBlueprintView(makeBlueprint());
		expect(result).toContain('\u2B1C 08:00-09:00');
	});

	it('renders time blocks with checkmark icon for isSlot=false', () => {
		const result = renderBlueprintView(makeBlueprint());
		expect(result).toContain('\u2705 07:00-07:30 Shower');
	});

	it('renders "Available slot" in italics when label is null', () => {
		const result = renderBlueprintView(makeBlueprint());
		expect(result).toContain('<i>Available slot</i>');
	});

	it('shows Active status when blueprint is active', () => {
		const result = renderBlueprintView(makeBlueprint({ isActive: true }));
		expect(result).toContain('<i>Active</i>');
	});

	it('shows Inactive status when blueprint is inactive', () => {
		const result = renderBlueprintView(makeBlueprint({ isActive: false }));
		expect(result).toContain('<i>Inactive</i>');
	});
});

describe('renderBlueprintListText', () => {
	it('renders empty message when no blueprints', () => {
		const result = renderBlueprintListText([]);
		expect(result).toContain('No blueprints');
	});

	it('renders blueprint list with active indicator', () => {
		const result = renderBlueprintListText([
			{ id: 1, name: 'Weekday', isActive: true },
			{ id: 2, name: 'Weekend', isActive: false },
		]);
		expect(result).toContain('1.');
		expect(result).toContain('Weekday');
		expect(result).toContain('\u2705');
		expect(result).toContain('2.');
		expect(result).toContain('Weekend');
	});
});

// --- Handler tests ---

describe('registerBlueprintHandlers', () => {
	let bot: Bot<StitchContext>;
	let mockService: {
		createBlueprint: ReturnType<typeof vi.fn>;
		addCycle: ReturnType<typeof vi.fn>;
		addTimeBlock: ReturnType<typeof vi.fn>;
		getFullBlueprint: ReturnType<typeof vi.fn>;
		getActiveBlueprint: ReturnType<typeof vi.fn>;
		setActive: ReturnType<typeof vi.fn>;
		deleteBlueprint: ReturnType<typeof vi.fn>;
		listBlueprints: ReturnType<typeof vi.fn>;
	};

	// Capture outgoing API calls
	let lastReply: { text: string; options?: Record<string, unknown> } | undefined;

	function makeUpdate(text: string) {
		return {
			update_id: 1,
			message: {
				message_id: 1,
				date: Date.now(),
				chat: { id: 123, type: 'private' as const },
				from: { id: 123, is_bot: false, first_name: 'Test' },
				text,
			},
		};
	}

	beforeEach(() => {
		lastReply = undefined;
		mockService = {
			createBlueprint: vi.fn().mockReturnValue({ id: 1, name: 'Weekday' }),
			addCycle: vi.fn().mockReturnValue({ id: 1 }),
			addTimeBlock: vi.fn().mockReturnValue({ id: 1 }),
			getFullBlueprint: vi.fn(),
			getActiveBlueprint: vi.fn(),
			setActive: vi.fn(),
			deleteBlueprint: vi.fn(),
			listBlueprints: vi.fn().mockReturnValue([]),
		};

		bot = new Bot<StitchContext>('fake-token');
		// Intercept all outgoing API calls
		bot.api.config.use((prev, method, payload) => {
			if (method === 'sendMessage') {
				const p = payload as { text: string; parse_mode?: string };
				lastReply = { text: p.text, options: payload as Record<string, unknown> };
			}
			return { ok: true, result: true } as ReturnType<typeof prev>;
		});

		registerBlueprintHandlers(bot, mockService as never);
	});

	it('"blueprint create Weekday" calls createBlueprint and replies', async () => {
		await bot.handleUpdate(makeUpdate('blueprint create Weekday'));
		expect(mockService.createBlueprint).toHaveBeenCalledWith({ name: 'Weekday' });
		expect(lastReply?.text).toContain('Blueprint created');
		expect(lastReply?.text).toContain('Weekday');
	});

	it('"blueprint cycle 1 Morning duties 07:00-09:00" calls addCycle', async () => {
		await bot.handleUpdate(makeUpdate('blueprint cycle 1 Morning duties 07:00-09:00'));
		expect(mockService.addCycle).toHaveBeenCalledWith(
			expect.objectContaining({
				blueprintId: 1,
				name: 'Morning duties',
				startTime: '07:00',
				endTime: '09:00',
			}),
		);
		expect(lastReply?.text).toContain('Cycle added');
	});

	it('"blueprint block 1 Shower 07:00-07:30" calls addTimeBlock with isSlot=false', async () => {
		await bot.handleUpdate(makeUpdate('blueprint block 1 Shower 07:00-07:30'));
		expect(mockService.addTimeBlock).toHaveBeenCalledWith(
			expect.objectContaining({
				cycleId: 1,
				label: 'Shower',
				startTime: '07:00',
				endTime: '07:30',
				isSlot: false,
			}),
		);
		expect(lastReply?.text).toContain('Block added');
	});

	it('"blueprint slot 1 08:00-09:00" calls addTimeBlock with isSlot=true', async () => {
		await bot.handleUpdate(makeUpdate('blueprint slot 1 08:00-09:00'));
		expect(mockService.addTimeBlock).toHaveBeenCalledWith(
			expect.objectContaining({
				cycleId: 1,
				startTime: '08:00',
				endTime: '09:00',
				isSlot: true,
			}),
		);
		expect(lastReply?.text).toContain('Slot added');
	});

	it('"blueprint activate 1" calls setActive', async () => {
		await bot.handleUpdate(makeUpdate('blueprint activate 1'));
		expect(mockService.setActive).toHaveBeenCalledWith(1);
		expect(lastReply?.text).toContain('activated');
	});

	it('"blueprint show" calls getActiveBlueprint and replies with rendered view', async () => {
		mockService.getActiveBlueprint.mockReturnValue({
			id: 1,
			name: 'Weekday',
			isActive: true,
			cycles: [],
		});
		await bot.handleUpdate(makeUpdate('blueprint show'));
		expect(mockService.getActiveBlueprint).toHaveBeenCalled();
		expect(lastReply?.text).toContain('Blueprint: Weekday');
	});

	it('"blueprint show" replies with no active blueprint message when none exists', async () => {
		mockService.getActiveBlueprint.mockReturnValue(undefined);
		await bot.handleUpdate(makeUpdate('blueprint show'));
		expect(lastReply?.text).toContain('No active blueprint');
	});

	it('"blueprint delete 1" calls deleteBlueprint', async () => {
		await bot.handleUpdate(makeUpdate('blueprint delete 1'));
		expect(mockService.deleteBlueprint).toHaveBeenCalledWith(1);
		expect(lastReply?.text).toContain('deleted');
	});

	it('"blueprint list" calls listBlueprints and renders list', async () => {
		mockService.listBlueprints.mockReturnValue([
			{ id: 1, name: 'Weekday', isActive: true },
		]);
		await bot.handleUpdate(makeUpdate('blueprint list'));
		expect(mockService.listBlueprints).toHaveBeenCalled();
		expect(lastReply?.text).toContain('Weekday');
	});
});

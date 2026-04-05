import { z } from 'zod';

const timeRegex = /^([01]\d|2[0-3]):[0-5]\d$/;

export const createBlueprintSchema = z.object({
	name: z.string().min(1).max(100),
});

export const createCycleSchema = z.object({
	blueprintId: z.number().int().positive(),
	name: z.string().min(1).max(100),
	startTime: z.string().regex(timeRegex, 'Must be HH:MM format'),
	endTime: z.string().regex(timeRegex, 'Must be HH:MM format'),
	sortOrder: z.number().int().min(0).optional().default(0),
});

export const createTimeBlockSchema = z.object({
	cycleId: z.number().int().positive(),
	label: z.string().max(100).optional(),
	startTime: z.string().regex(timeRegex, 'Must be HH:MM format'),
	endTime: z.string().regex(timeRegex, 'Must be HH:MM format'),
	isSlot: z.boolean().optional().default(true),
	sortOrder: z.number().int().min(0).optional().default(0),
});

export type CreateBlueprintInput = z.infer<typeof createBlueprintSchema>;
export type CreateCycleInput = z.infer<typeof createCycleSchema>;
export type CreateTimeBlockInput = z.infer<typeof createTimeBlockSchema>;

export interface FullBlueprint {
	id: number;
	name: string;
	isActive: boolean;
	cycles: BlueprintCycle[];
}

export interface BlueprintCycle {
	id: number;
	name: string;
	startTime: string;
	endTime: string;
	sortOrder: number;
	timeBlocks: BlueprintTimeBlock[];
}

export interface BlueprintTimeBlock {
	id: number;
	label: string | null;
	startTime: string;
	endTime: string;
	isSlot: boolean;
	sortOrder: number;
}

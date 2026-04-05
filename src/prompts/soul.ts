import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOUL = readFileSync(resolve(__dirname, 'SOUL.md'), 'utf-8').trim();

export function withSoul(systemPrompt: string): string {
	return `${SOUL}\n\n---\n\n${systemPrompt}`;
}

export { SOUL };

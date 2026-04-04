import type { SttProvider, TranscribeResult } from './stt.js';

export class MockSttProvider implements SttProvider {
	private defaultText: string;

	constructor(defaultText = 'mock transcription') {
		this.defaultText = defaultText;
	}

	async transcribe(_audio: Buffer, _mimeType: string): Promise<TranscribeResult> {
		return { text: this.defaultText };
	}

	async healthCheck(): Promise<{ ok: boolean; error?: string }> {
		return { ok: true };
	}
}

import type { SttProvider, TranscribeResult } from './stt.js';

export class WhisperServerProvider implements SttProvider {
	private baseURL: string;

	constructor(config: { baseURL: string }) {
		this.baseURL = config.baseURL;
	}

	async transcribe(audio: Buffer, mimeType: string): Promise<TranscribeResult> {
		// Pitfall 4: whisper-server uses filename extension for format detection
		const ext = mimeType === 'audio/wav' ? 'wav' : 'audio';
		// Copy Buffer into a plain ArrayBuffer for Blob compatibility (avoids TS SharedArrayBuffer issue)
		const arrayBuffer = audio.buffer.slice(
			audio.byteOffset,
			audio.byteOffset + audio.byteLength,
		) as ArrayBuffer;
		const blob = new Blob([arrayBuffer], { type: mimeType });
		const form = new FormData();
		form.append('file', blob, `audio.${ext}`);
		form.append('response_format', 'json');

		const response = await fetch(`${this.baseURL}/v1/audio/transcriptions`, {
			method: 'POST',
			body: form,
		});

		if (!response.ok) {
			throw new Error(`Whisper transcription failed: HTTP ${response.status}`);
		}

		const data = (await response.json()) as { text: string };
		return { text: data.text };
	}

	async healthCheck(): Promise<{ ok: boolean; error?: string }> {
		try {
			const response = await fetch(`${this.baseURL}/health`);
			if (response.ok) return { ok: true };
			return { ok: false, error: `HTTP ${response.status}` };
		} catch (err) {
			return {
				ok: false,
				error: err instanceof Error ? err.message : 'Connection failed',
			};
		}
	}
}

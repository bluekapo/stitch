import { convertToWav } from './audio-convert.js';
import type { SttProvider, TranscribeResult } from './stt.js';

export class WhisperServerProvider implements SttProvider {
	private baseURL: string;

	constructor(config: { baseURL: string }) {
		this.baseURL = config.baseURL;
	}

	async transcribe(audio: Buffer, mimeType: string): Promise<TranscribeResult> {
		// whisper.cpp server requires WAV format — convert non-WAV audio
		let audioData = audio;
		let finalMimeType = mimeType;

		if (mimeType !== 'audio/wav') {
			audioData = await convertToWav(audio);
			finalMimeType = 'audio/wav';
		}

		// Copy Buffer into a plain ArrayBuffer for Blob compatibility (avoids TS SharedArrayBuffer issue)
		const arrayBuffer = audioData.buffer.slice(
			audioData.byteOffset,
			audioData.byteOffset + audioData.byteLength,
		) as ArrayBuffer;
		const blob = new Blob([arrayBuffer], { type: finalMimeType });
		const form = new FormData();
		form.append('file', blob, 'audio.wav');
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

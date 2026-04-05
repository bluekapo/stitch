export interface TranscribeResult {
	text: string;
}

export interface SttProvider {
	/** Transcribe audio buffer to text */
	transcribe(audio: Buffer, mimeType: string): Promise<TranscribeResult>;

	/** Check if the STT backend is reachable and ready */
	healthCheck(): Promise<{ ok: boolean; error?: string }>;
}

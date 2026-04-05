/**
 * Pure JS OGG/OPUS to WAV conversion using ogg-opus-decoder WASM.
 * No external binaries (ffmpeg) required.
 *
 * Output: 16kHz mono 16-bit signed PCM WAV.
 */
import { OggOpusDecoder } from 'ogg-opus-decoder';

const TARGET_SAMPLE_RATE = 16000;

/**
 * Decode an OGG/OPUS buffer and return a 16kHz mono 16-bit PCM WAV buffer.
 */
export async function convertToWav(input: Buffer): Promise<Buffer> {
	const decoder = new OggOpusDecoder();
	await decoder.ready;

	try {
		const decoded = await decoder.decodeFile(new Uint8Array(input));
		const rawSamples = decoded.channelData[0]; // mono: first channel
		const sourceSampleRate = decoded.sampleRate; // always 48000 for OPUS

		// Downsample from sourceSampleRate to TARGET_SAMPLE_RATE
		const decimationFactor = sourceSampleRate / TARGET_SAMPLE_RATE;
		const outputLength = Math.floor(rawSamples.length / decimationFactor);
		const int16Samples = new Int16Array(outputLength);

		for (let i = 0; i < outputLength; i++) {
			const srcIndex = Math.floor(i * decimationFactor);
			// Clamp to [-1, 1] and convert Float32 to Int16
			const clamped = Math.max(-1, Math.min(1, rawSamples[srcIndex]));
			int16Samples[i] = Math.round(clamped * 32767);
		}

		// Build WAV header (44 bytes)
		const dataSize = int16Samples.length * 2; // 2 bytes per Int16 sample
		const header = Buffer.alloc(44);

		// RIFF chunk descriptor
		header.write('RIFF', 0, 'ascii');
		header.writeUInt32LE(36 + dataSize, 4); // ChunkSize
		header.write('WAVE', 8, 'ascii');

		// fmt sub-chunk
		header.write('fmt ', 12, 'ascii');
		header.writeUInt32LE(16, 16); // Subchunk1Size (PCM)
		header.writeUInt16LE(1, 20); // AudioFormat = 1 (PCM)
		header.writeUInt16LE(1, 22); // NumChannels = 1 (mono)
		header.writeUInt32LE(TARGET_SAMPLE_RATE, 24); // SampleRate
		header.writeUInt32LE(TARGET_SAMPLE_RATE * 1 * 2, 28); // ByteRate
		header.writeUInt16LE(1 * 2, 32); // BlockAlign
		header.writeUInt16LE(16, 34); // BitsPerSample

		// data sub-chunk
		header.write('data', 36, 'ascii');
		header.writeUInt32LE(dataSize, 40); // Subchunk2Size

		// Combine header + PCM data
		const pcmBuffer = Buffer.from(
			int16Samples.buffer,
			int16Samples.byteOffset,
			int16Samples.byteLength,
		);
		return Buffer.concat([header, pcmBuffer]);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Audio conversion failed: ${message}`);
	} finally {
		decoder.free();
	}
}

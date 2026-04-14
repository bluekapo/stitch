import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockDecodeFile = vi.fn();
const mockFree = vi.fn();

vi.mock('ogg-opus-decoder', () => ({
	OggOpusDecoder: class {
		ready = Promise.resolve();
		decodeFile = mockDecodeFile;
		free = mockFree;
	},
}));

import { convertToWav } from '../../src/providers/audio-convert.js';

describe('convertToWav', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('decodes OGG/OPUS and returns valid WAV buffer with correct header', async () => {
		// 9 samples at 48kHz -> decimation factor 3 -> 3 output samples at 16kHz
		const samples = new Float32Array([0.5, 0.1, -0.1, -0.5, 0.2, -0.2, 0.0, 0.3, -0.3]);
		mockDecodeFile.mockResolvedValueOnce({
			channelData: [samples],
			samplesDecoded: 9,
			sampleRate: 48000,
			errors: [],
		});

		const wav = await convertToWav(Buffer.from('fake-ogg-data'));

		// RIFF header
		expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
		// WAVE format
		expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
		// fmt chunk
		expect(wav.toString('ascii', 12, 16)).toBe('fmt ');
		// AudioFormat = 1 (PCM)
		expect(wav.readUInt16LE(20)).toBe(1);
		// NumChannels = 1
		expect(wav.readUInt16LE(22)).toBe(1);
		// SampleRate = 16000
		expect(wav.readUInt32LE(24)).toBe(16000);
		// ByteRate = 32000
		expect(wav.readUInt32LE(28)).toBe(32000);
		// BlockAlign = 2
		expect(wav.readUInt16LE(32)).toBe(2);
		// BitsPerSample = 16
		expect(wav.readUInt16LE(34)).toBe(16);
		// data chunk
		expect(wav.toString('ascii', 36, 40)).toBe('data');
		// 3 output samples * 2 bytes = 6 bytes of PCM data
		expect(wav.readUInt32LE(40)).toBe(6);
		// Total length = 44 header + 6 data = 50
		expect(wav.length).toBe(50);
	});

	it('downsamples 48kHz to 16kHz correctly', async () => {
		// 9 samples at 48kHz -> factor 3 -> pick indices 0, 3, 6 -> 3 samples at 16kHz
		const samples = new Float32Array([0.5, 0.1, -0.1, -0.5, 0.2, -0.2, 0.0, 0.3, -0.3]);
		mockDecodeFile.mockResolvedValueOnce({
			channelData: [samples],
			samplesDecoded: 9,
			sampleRate: 48000,
			errors: [],
		});

		const wav = await convertToWav(Buffer.from('fake-ogg-data'));

		// PCM data starts at offset 44
		// Expected Int16 values: 0.5*32767=16384, -0.5*32767=-16384, 0.0*32767=0
		const sample0 = wav.readInt16LE(44);
		const sample1 = wav.readInt16LE(46);
		const sample2 = wav.readInt16LE(48);

		expect(sample0).toBe(Math.round(0.5 * 32767));
		expect(sample1).toBe(Math.round(-0.5 * 32767));
		expect(sample2).toBe(Math.round(0.0 * 32767));
	});

	it('rejects with descriptive error when decode fails', async () => {
		mockDecodeFile.mockRejectedValueOnce(new Error('Corrupt OGG data'));

		await expect(convertToWav(Buffer.from('bad-data'))).rejects.toThrow('Audio conversion failed');
	});

	it('calls decoder.free() even when decode fails', async () => {
		mockDecodeFile.mockRejectedValueOnce(new Error('Corrupt OGG data'));

		await convertToWav(Buffer.from('bad-data')).catch(() => {});

		expect(mockFree).toHaveBeenCalledOnce();
	});
});

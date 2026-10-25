import { describe, expect, it } from 'vitest';
import {
  BoundedFrameQueue,
  ChunkAssembler,
  DEFAULT_CHUNK_POLICY,
  SequenceTracker,
  bytesToBase64,
  downsampleTo16k,
  durationMs,
  encodeWav16k,
  rms,
  TARGET_SAMPLE_RATE,
} from '../src/shared/audioFraming';

/** A frame of `n` samples at a given amplitude (a cheap stand-in for speech). */
function frame(n: number, amplitude: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = Math.sin((2 * Math.PI * 220 * i) / TARGET_SAMPLE_RATE) * amplitude;
  }
  return out;
}

describe('downsampleTo16k', () => {
  it('reduces a 48 kHz buffer to exactly one third of the samples', () => {
    const out = downsampleTo16k(new Float32Array(48_000), 48_000);
    expect(out.length).toBe(16_000);
  });

  it('passes 16 kHz through untouched', () => {
    const input = frame(320, 0.3);
    const out = downsampleTo16k(input, TARGET_SAMPLE_RATE);
    expect(out.length).toBe(input.length);
    expect(out[10]).toBeCloseTo(input[10] ?? 0, 6);
  });

  it('preserves approximate amplitude rather than aliasing it away', () => {
    const input = frame(9_600, 0.5);
    const out = downsampleTo16k(input, 48_000);
    expect(rms(out)).toBeGreaterThan(0.2);
    expect(rms(out)).toBeLessThan(0.6);
  });

  it('returns empty for an empty or invalid input', () => {
    expect(downsampleTo16k(new Float32Array(0), 48_000).length).toBe(0);
    expect(downsampleTo16k(new Float32Array(100), 0).length).toBe(0);
  });
});

describe('encodeWav16k', () => {
  it('writes a valid mono 16-bit RIFF header', () => {
    const samples = new Float32Array(160);
    const wav = encodeWav16k(samples);
    const view = new DataView(wav.buffer);

    const ascii = (offset: number, length: number): string =>
      Array.from({ length }, (_, i) => String.fromCharCode(view.getUint8(offset + i))).join('');

    expect(ascii(0, 4)).toBe('RIFF');
    expect(ascii(8, 4)).toBe('WAVE');
    expect(ascii(12, 4)).toBe('fmt ');
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(ascii(36, 4)).toBe('data');
    expect(view.getUint32(40, true)).toBe(samples.length * 2);
    expect(wav.length).toBe(44 + samples.length * 2);
  });

  it('clamps out-of-range samples instead of wrapping them', () => {
    const wav = encodeWav16k(new Float32Array([2, -2, 0]));
    const view = new DataView(wav.buffer);
    expect(view.getInt16(44, true)).toBe(32767);
    expect(view.getInt16(46, true)).toBe(-32768);
    expect(view.getInt16(48, true)).toBe(0);
  });

  it('base64-encodes without a DOM or Node Buffer in scope', () => {
    const encoded = bytesToBase64(new Uint8Array([82, 73, 70, 70])); // "RIFF"
    expect(encoded).toBe('UklGRg==');
  });
});

describe('durationMs', () => {
  it('converts sample counts at 16 kHz', () => {
    expect(durationMs(16_000)).toBe(1000);
    expect(durationMs(3_840)).toBe(240);
  });
});

describe('BoundedFrameQueue', () => {
  it('drops the oldest frame and counts the loss when saturated', () => {
    const queue = new BoundedFrameQueue<{ seq: number; at: number }>(3);
    for (let seq = 0; seq < 6; seq += 1) queue.push({ seq, at: seq * 10 });

    expect(queue.size).toBe(3);
    expect(queue.dropped).toBe(3);
    // Frames 0..2 were evicted, 3..5 survive.
    expect(queue.shift()?.seq).toBe(3);
  });

  it('reports the age of the oldest queued frame', () => {
    const queue = new BoundedFrameQueue<{ at: number }>(4);
    queue.push({ at: 1000 });
    queue.push({ at: 1500 });
    expect(queue.stats(2500)).toMatchObject({ size: 2, oldestAgeMs: 1500, dropped: 0 });
  });

  it('reports a zero age when empty and clears cleanly', () => {
    const queue = new BoundedFrameQueue<{ at: number }>(2);
    expect(queue.stats(9).oldestAgeMs).toBe(0);
    queue.push({ at: 1 });
    queue.clear();
    expect(queue.size).toBe(0);
    expect(queue.peek()).toBeUndefined();
  });

  it('refuses a nonsensical capacity', () => {
    expect(() => new BoundedFrameQueue(0)).toThrow();
  });
});

describe('SequenceTracker', () => {
  it('accepts in-order frames', () => {
    const tracker = new SequenceTracker();
    expect(tracker.observe(0).verdict).toBe('ok');
    expect(tracker.observe(1).verdict).toBe('ok');
    expect(tracker.observe(2).verdict).toBe('ok');
  });

  it('detects a duplicate frame', () => {
    const tracker = new SequenceTracker();
    tracker.observe(0);
    tracker.observe(1);
    expect(tracker.observe(1).verdict).toBe('duplicate');
  });

  it('detects an out-of-order frame that arrives after a newer one', () => {
    const tracker = new SequenceTracker();
    tracker.observe(0);
    tracker.observe(5);
    expect(tracker.observe(3).verdict).toBe('out-of-order');
  });

  it('reports how many frames a gap swallowed', () => {
    const tracker = new SequenceTracker();
    tracker.observe(0);
    const result = tracker.observe(4);
    expect(result.verdict).toBe('gap');
    expect(result.missing).toBe(3);
  });

  it('does not treat the first frame as a gap', () => {
    const tracker = new SequenceTracker();
    expect(tracker.observe(7)).toMatchObject({ verdict: 'ok', missing: 0 });
  });
});

describe('ChunkAssembler', () => {
  const policy = DEFAULT_CHUNK_POLICY;
  const frameSamples = Math.round((20 / 1000) * TARGET_SAMPLE_RATE); // 20 ms frames

  it('holds audio until a chunk has been spoken', () => {
    const assembler = new ChunkAssembler(policy);
    expect(assembler.push(frame(frameSamples, 0.2))).toBeNull();
    expect(assembler.pendingSamples).toBeGreaterThan(0);
  });

  it('releases on silence once the target length is reached', () => {
    const assembler = new ChunkAssembler(policy);
    let chunk = null;
    // ~2.5 s of speech, then quiet long enough to close the thought.
    for (let i = 0; i < 125 && chunk === null; i += 1) chunk = assembler.push(frame(frameSamples, 0.2));
    for (let i = 0; i < 30 && chunk === null; i += 1) chunk = assembler.push(frame(frameSamples, 0));

    expect(chunk).not.toBeNull();
    expect(chunk?.endedOnSilence).toBe(true);
    expect(chunk?.durationMs).toBeGreaterThanOrEqual(policy.chunkMs);
  });

  it('releases mid-sentence at the hard max-wait, so a non-stop talker still gets text', () => {
    const assembler = new ChunkAssembler(policy);
    let chunk = null;
    for (let i = 0; i < 400 && chunk === null; i += 1) chunk = assembler.push(frame(frameSamples, 0.2));

    expect(chunk).not.toBeNull();
    expect(chunk?.endedOnSilence).toBe(false);
    expect(chunk?.durationMs).toBeGreaterThanOrEqual(policy.hardMaxMs);
  });

  it('never ships pure silence to the recogniser', () => {
    const assembler = new ChunkAssembler(policy);
    let chunk = null;
    for (let i = 0; i < 100 && chunk === null; i += 1) chunk = assembler.push(frame(frameSamples, 0));
    expect(chunk).toBeNull();
    expect(assembler.emittedChunks).toBe(0);
  });

  it('tracks a continuous sample timeline across chunks', () => {
    const assembler = new ChunkAssembler(policy);
    const chunks = [];
    // 460 frames x 20 ms = 9.2 s, comfortably past two hard-max releases (4.2 s each).
    for (let i = 0; i < 460; i += 1) {
      const chunk = assembler.push(frame(frameSamples, 0.2));
      if (chunk !== null) chunks.push(chunk);
    }
    expect(chunks.length).toBeGreaterThan(1);
    // Second chunk starts where the first one ended: no silent overlap.
    expect(chunks[1]?.startSample).toBe((chunks[0]?.startSample ?? 0) + (chunks[0]?.samples.length ?? 0));
  });

  it('flushes the trailing audio so the last sentence is not lost', () => {
    const assembler = new ChunkAssembler(policy);
    assembler.push(frame(frameSamples, 0.2));
    expect(assembler.flush()).not.toBeNull();
    expect(assembler.flush()).toBeNull();
  });
});

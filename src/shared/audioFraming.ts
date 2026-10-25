/**
 * Audio framing and buffering primitives, shared by the browser and the server.
 *
 * This module exists because the free-tier transcription path (a chunked
 * OpenAI-compatible `/audio/transcriptions` endpoint) has no transport of its
 * own: we own the framing, the ordering and the backpressure. The paid WebRTC
 * path delegates all of that to the provider, which is why it needed none of
 * this code.
 *
 * Everything here is pure and environment-agnostic (no Node APIs, no DOM), so
 * it is unit tested directly in tests/audioFraming.test.ts.
 */

/** Speech providers are happiest at 16 kHz mono. */
export const TARGET_SAMPLE_RATE = 16_000;

export interface AudioFrame {
  /** Monotonic per-session frame number, starting at 0. */
  seq: number;
  /** Index of this frame's first sample in the session's 16 kHz timeline. */
  startSample: number;
  /** 16 kHz mono samples. */
  samples: Float32Array<ArrayBuffer>;
  /** Epoch ms when the frame was produced. */
  at: number;
}

/**
 * Box-filter decimation from an arbitrary input rate to 16 kHz.
 *
 * Averaging (rather than picking every Nth sample) is what stops speech from
 * aliasing into something the recogniser mis-hears. A frame boundary can clip
 * one averaging window by a sample or two; at 20 ms frames that is inaudible
 * and it keeps the function stateless.
 */
export function downsampleTo16k(
  input: Float32Array,
  inputRate: number,
): Float32Array<ArrayBuffer> {
  if (inputRate <= 0 || input.length === 0) return new Float32Array(0);
  if (inputRate === TARGET_SAMPLE_RATE) return new Float32Array(input);

  const outLength = Math.max(1, Math.floor((input.length * TARGET_SAMPLE_RATE) / inputRate));
  const out = new Float32Array(outLength);

  for (let i = 0; i < outLength; i += 1) {
    const start = Math.floor((i * inputRate) / TARGET_SAMPLE_RATE);
    const end = Math.min(
      input.length,
      Math.max(start + 1, Math.floor(((i + 1) * inputRate) / TARGET_SAMPLE_RATE)),
    );
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += input[j] ?? 0;
    out[i] = sum / (end - start);
  }

  return out;
}

/** Root-mean-square amplitude, the cheap signal we use for speech activity. */
export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i] ?? 0;
    sum += value * value;
  }
  return Math.sqrt(sum / samples.length);
}

/**
 * Encode 16 kHz mono Float32 samples as a self-contained 16-bit PCM WAV file.
 *
 * Every chunk must be independently decodable, which is exactly why this is not
 * `MediaRecorder`: `dataavailable` slices after the first carry no container
 * header, so a batch endpoint receives bytes it cannot decode. A WAV per chunk
 * costs ~2 bytes/sample more and always decodes.
 */
export function encodeWav16k(samples: Float32Array): Uint8Array<ArrayBuffer> {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const sampleRate = TARGET_SAMPLE_RATE;

  const writeAscii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true); // byte rate
  view.setUint16(32, bytesPerSample, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, 'data');
  view.setUint32(40, dataSize, true);

  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    // Asymmetric scaling: int16 ranges -32768..32767.
    const scaled = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    view.setInt16(44 + i * bytesPerSample, Math.round(scaled), true);
  }

  return new Uint8Array(buffer);
}

/** Bytes -> base64, without assuming a browser or Node global is present. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  if (typeof btoa === 'function') return btoa(binary);
  // Server-side fallback; guarded so shared code still type-checks for the browser.
  const globalBuffer = (globalThis as { Buffer?: { from(input: string, enc: string): { toString(enc: string): string } } })
    .Buffer;
  if (globalBuffer !== undefined) return globalBuffer.from(binary, 'binary').toString('base64');
  throw new Error('No base64 encoder available');
}

/** Duration of a float sample count at the target rate. */
export function durationMs(sampleCount: number, sampleRate = TARGET_SAMPLE_RATE): number {
  return Math.round((sampleCount / sampleRate) * 1000);
}

/* -------------------------------------------------------------------------- */
/* Bounded queue                                                              */
/* -------------------------------------------------------------------------- */

export interface QueueStats {
  size: number;
  maxFrames: number;
  dropped: number;
  /** Age of the oldest queued frame, 0 when empty. */
  oldestAgeMs: number;
}

/**
 * A bounded FIFO with an explicit overflow policy.
 *
 * Dropping the OLDEST frame is the right choice for live speech: a chunk that
 * arrives 10 seconds late is worth less than the words being spoken now. Every
 * drop is counted so the UI can say so instead of pretending the session was
 * continuous.
 */
export class BoundedFrameQueue<T extends { at: number }> {
  private readonly items: T[] = [];
  private droppedCount = 0;

  constructor(private readonly maxFrames: number) {
    if (maxFrames < 1) throw new Error('BoundedFrameQueue needs maxFrames >= 1');
  }

  push(item: T): void {
    this.items.push(item);
    while (this.items.length > this.maxFrames) {
      this.items.shift();
      this.droppedCount += 1;
    }
  }

  shift(): T | undefined {
    return this.items.shift();
  }

  peek(): T | undefined {
    return this.items[0];
  }

  clear(): void {
    this.items.length = 0;
  }

  get size(): number {
    return this.items.length;
  }

  get dropped(): number {
    return this.droppedCount;
  }

  stats(now: number): QueueStats {
    const oldest = this.items[0];
    return {
      size: this.items.length,
      maxFrames: this.maxFrames,
      dropped: this.droppedCount,
      oldestAgeMs: oldest === undefined ? 0 : Math.max(0, now - oldest.at),
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Ordering                                                                   */
/* -------------------------------------------------------------------------- */

export type FrameOrderVerdict = 'ok' | 'duplicate' | 'out-of-order' | 'gap';

export interface OrderObservation {
  verdict: FrameOrderVerdict;
  /** How many frames are missing, when verdict is 'gap'. */
  missing: number;
}

/**
 * Detects duplicate, missing and out-of-order frames from the sequence number
 * alone, so a known discontinuity is never presented as continuous speech.
 */
export class SequenceTracker {
  private highestSeen = -1;

  observe(seq: number): OrderObservation {
    if (seq <= this.highestSeen) {
      return { verdict: seq === this.highestSeen ? 'duplicate' : 'out-of-order', missing: 0 };
    }
    const missing = this.highestSeen === -1 ? 0 : seq - this.highestSeen - 1;
    this.highestSeen = seq;
    return missing > 0 ? { verdict: 'gap', missing } : { verdict: 'ok', missing: 0 };
  }

  reset(): void {
    this.highestSeen = -1;
  }

  get lastSeq(): number {
    return this.highestSeen;
  }
}

/* -------------------------------------------------------------------------- */
/* Sentence-aware chunking                                                    */
/* -------------------------------------------------------------------------- */

export interface ChunkPolicy {
  /** Target chunk length. 2400 ms keeps a batch recogniser under its limit. */
  chunkMs: number;
  /** Trailing quiet needed to treat the chunk as a finished thought. */
  silenceMs: number;
  /** Never hold audio longer than this, even mid-sentence (the max-wait rule). */
  hardMaxMs: number;
  /** Amplitude below which a sample window counts as silence. */
  silenceRms: number;
  /** Chunks quieter than this overall are discarded rather than transcribed. */
  minSpeechRms: number;
}

export const DEFAULT_CHUNK_POLICY: ChunkPolicy = {
  chunkMs: 2400,
  silenceMs: 420,
  hardMaxMs: 4200,
  silenceRms: 0.006,
  minSpeechRms: 0.004,
};

export interface AssembledChunk {
  samples: Float32Array<ArrayBuffer>;
  startSample: number;
  durationMs: number;
  /** True when released by the silence rule, false by the hard max-wait rule. */
  endedOnSilence: boolean;
}

/**
 * Accumulates 16 kHz frames and releases them as chunks.
 *
 * The policy is deliberately both sentence-aware and bounded: a chunk is
 * released when the speaker pauses AND the chunk is worth sending, or when the
 * hard maximum is hit mid-sentence. Without the second rule a talker who never
 * pauses would produce one enormous chunk and no transcript at all, which is
 * precisely the failure the addendum's "maximum-wait safeguard" describes.
 */
export class ChunkAssembler {
  private readonly policy: ChunkPolicy;
  private buffer: Float32Array[] = [];
  private bufferedSamples = 0;
  private trailingSilenceSamples = 0;
  private chunkStartSample = 0;
  private totalSamples = 0;
  private emitted = 0;

  constructor(policy: ChunkPolicy = DEFAULT_CHUNK_POLICY) {
    this.policy = policy;
  }

  private samplesFor(ms: number): number {
    return Math.round((ms / 1000) * TARGET_SAMPLE_RATE);
  }

  /** Feed one frame. Returns a chunk only when the policy says to ship it. */
  push(frame: Float32Array): AssembledChunk | null {
    if (frame.length === 0) return null;
    this.buffer.push(new Float32Array(frame));
    this.bufferedSamples += frame.length;
    this.totalSamples += frame.length;

    if (rms(frame) < this.policy.silenceRms) {
      this.trailingSilenceSamples += frame.length;
    } else {
      this.trailingSilenceSamples = 0;
    }

    const enoughForChunk = this.bufferedSamples >= this.samplesFor(this.policy.chunkMs);
    const enoughSilence = this.trailingSilenceSamples >= this.samplesFor(this.policy.silenceMs);
    const pastHardMax = this.bufferedSamples >= this.samplesFor(this.policy.hardMaxMs);

    if (pastHardMax) return this.release(false);
    if (enoughForChunk && enoughSilence) return this.release(true);
    return null;
  }

  /**
   * Release a trailing chunk when capture stops. Unless `flush` is false this
   * returns whatever is buffered, because the last thing the speaker said
   * before Stop is usually the thing that needed an answer.
   */
  flush(): AssembledChunk | null {
    if (this.bufferedSamples === 0) return null;
    return this.release(this.trailingSilenceSamples > 0);
  }

  private release(endedOnSilence: boolean): AssembledChunk | null {
    const merged = new Float32Array(this.bufferedSamples);
    let offset = 0;
    for (const part of this.buffer) {
      merged.set(part, offset);
      offset += part.length;
    }

    const startSample = this.chunkStartSample;
    this.buffer = [];
    this.bufferedSamples = 0;
    this.trailingSilenceSamples = 0;
    this.chunkStartSample = this.totalSamples;
    this.emitted += 1;

    // Never ship pure room tone: it costs a request and returns a hallucinated
    // word or nothing at all.
    if (rms(merged) < this.policy.minSpeechRms) return null;

    return {
      samples: merged,
      startSample,
      durationMs: durationMs(merged.length),
      endedOnSilence,
    };
  }

  /** Samples held back, for the "buffered" indicator. */
  get pendingSamples(): number {
    return this.bufferedSamples;
  }

  get emittedChunks(): number {
    return this.emitted;
  }

  reset(): void {
    this.buffer = [];
    this.bufferedSamples = 0;
    this.trailingSilenceSamples = 0;
    this.chunkStartSample = 0;
    this.totalSamples = 0;
  }
}

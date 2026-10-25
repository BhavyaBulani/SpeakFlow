import { captureError } from '../../shared/errors';
import {
  BoundedFrameQueue,
  ChunkAssembler,
  DEFAULT_CHUNK_POLICY,
  SequenceTracker,
  TARGET_SAMPLE_RATE,
  bytesToBase64,
  downsampleTo16k,
  encodeWav16k,
  rms,
} from '../../shared/audioFraming';
import { ApiRequestError } from '../lib/api';
import type { ProviderContext, TranscriptionProvider } from './types';

/**
 * Chunked speech-to-text in the browser.
 *
 * This is the ₹0 path: audio is cut into short self-contained WAV chunks and
 * posted to our backend, which forwards each one to an OpenAI-compatible
 * `/audio/transcriptions` endpoint. Free tiers offer that endpoint; they do not
 * offer a WebRTC streaming socket.
 *
 * WHAT THIS IS HONESTLY NOT
 * There are no interim partials here. Text appears when a chunk closes, so the
 * transcript steps forward roughly every 1.5-3 s instead of growing word by
 * word, and a "provisional while the speaker is still talking" reply cannot be
 * produced from this source. The UI says which mode is running for exactly this
 * reason. `RealtimeTranscriptionProvider` is the path that does stream.
 *
 * Failure model: each chunk is independent, so a single failed chunk loses that
 * fragment and nothing else. Consecutive failures beyond a threshold stop the
 * session with an actionable error rather than looping forever against a quota
 * that is already spent.
 */

const FRAME_SAMPLES = 4096; // ~256 ms at 16 kHz
const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_PENDING_CHUNKS = 4;
const SPEECH_ON_RMS = 0.008;
const SPEECH_OFF_FRAMES = 6;

interface PendingChunk {
  seq: number;
  startSample: number;
  wavBase64: string;
  at: number;
}

export class ChunkedSttProvider implements TranscriptionProvider {
  readonly id = 'chunked-stt' as const;
  readonly label = 'Chunked speech-to-text';
  readonly note =
    'Audio is cut into short chunks and sent through this app to the transcription provider. Text appears as each chunk is recognised, not word by word.';
  readonly consumesCapturedStream = true;

  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private sink: GainNode | null = null;

  private assembler = new ChunkAssembler();
  private tracker = new SequenceTracker();
  private queue = new BoundedFrameQueue<PendingChunk>(MAX_PENDING_CHUNKS);
  private seq = 0;
  private consecutiveFailures = 0;
  private pumping = false;
  private stopped = true;
  private interrupted = false;

  private speechActive = false;
  private quietFrames = 0;

  private channels: { emit: ProviderContext['emit']; transcribe: NonNullable<ProviderContext['transcribeChunk']> } | null =
    null;

  async start(context: ProviderContext): Promise<void> {
    this.stopped = false;
    this.interrupted = false;
    this.consecutiveFailures = 0;
    this.seq = 0;
    this.tracker.reset();
    this.assembler = new ChunkAssembler(DEFAULT_CHUNK_POLICY);
    this.queue = new BoundedFrameQueue<PendingChunk>(MAX_PENDING_CHUNKS);

    const stream = context.stream;
    if (stream === null || stream.getAudioTracks().length === 0) {
      context.emit({ type: 'error', error: captureError('NO_AUDIO_TRACK') });
      return;
    }

    if (context.transcribeChunk === undefined) {
      context.emit({
        type: 'error',
        error: captureError('PROVIDER_NOT_CONFIGURED', {
          message: 'Chunked transcription needs a server session before it can start.',
          hint: 'Start the session again. If this repeats, check the server is running.',
        }),
      });
      return;
    }

    this.channels = { emit: context.emit, transcribe: context.transcribeChunk };
    context.emit({ type: 'status', status: 'connecting' });

    const AudioContextCtor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (AudioContextCtor === undefined) {
      context.emit({ type: 'error', error: captureError('UNSUPPORTED_BROWSER') });
      return;
    }

    // Ask for 16 kHz directly where supported: it saves a resample per frame and
    // matches what the recogniser wants anyway. Not every browser allows it, so
    // the fallback resamples instead of failing.
    let audioContext: AudioContext;
    try {
      audioContext = new AudioContextCtor({ sampleRate: TARGET_SAMPLE_RATE });
    } catch {
      audioContext = new AudioContextCtor();
    }
    this.context = audioContext;
    if (audioContext.state === 'suspended') await audioContext.resume().catch(() => undefined);

    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(FRAME_SAMPLES, 1, 1);
    // A muted sink keeps the processor pulling without playing the call back
    // through the speakers, which would echo into the client's own audio.
    const sink = audioContext.createGain();
    sink.gain.value = 0;

    this.source = source;
    this.processor = processor;
    this.sink = sink;

    const inputRate = audioContext.sampleRate;
    processor.onaudioprocess = (event: AudioProcessingEvent) => {
      if (this.stopped) return;
      const input = event.inputBuffer.getChannelData(0);
      const samples =
        Math.round(inputRate) === TARGET_SAMPLE_RATE
          ? new Float32Array(input)
          : downsampleTo16k(input, inputRate);
      this.consumeFrame(samples, context);
    };

    source.connect(processor);
    processor.connect(sink);
    sink.connect(audioContext.destination);

    context.emit({ type: 'status', status: 'listening' });
  }

  private consumeFrame(samples: Float32Array<ArrayBuffer>, context: ProviderContext): void {
    const level = rms(samples);

    if (level >= SPEECH_ON_RMS) {
      this.quietFrames = 0;
      if (!this.speechActive) {
        this.speechActive = true;
        context.emit({ type: 'speech-start', at: Date.now() });
      }
    } else if (this.speechActive) {
      this.quietFrames += 1;
      if (this.quietFrames >= SPEECH_OFF_FRAMES) {
        this.speechActive = false;
        context.emit({ type: 'speech-end', at: Date.now() });
      }
    }

    const chunk = this.assembler.push(samples);
    if (chunk === null) return;

    const observation = this.tracker.observe(this.seq);
    if (observation.verdict === 'gap') {
      // A gap is real information: the next transcript must not be presented as
      // continuous speech with what came before.
      this.interrupted = true;
      context.emit({
        type: 'context-uncertain',
        reason: `${observation.missing} audio chunk(s) were dropped`,
        at: Date.now(),
      });
    }

    const wav = encodeWav16k(chunk.samples);
    const droppedBefore = this.queue.dropped;
    this.queue.push({
      seq: this.seq,
      startSample: chunk.startSample,
      wavBase64: bytesToBase64(wav),
      at: Date.now(),
    });
    if (this.queue.dropped > droppedBefore) {
      // The recogniser is behind and the queue is full: the oldest audio went.
      this.interrupted = true;
      context.emit({
        type: 'context-uncertain',
        reason: 'the audio queue overflowed',
        at: Date.now(),
      });
    }
    this.seq += 1;

    void this.pump();
  }

  /** Send queued chunks one at a time, so a free tier is never burst-hammered. */
  private async pump(): Promise<void> {
    if (this.pumping || this.stopped || this.channels === null) return;
    this.pumping = true;

    try {
      for (;;) {
        const next = this.queue.shift();
        if (next === undefined || this.stopped) break;

        try {
          const result = await this.channels.transcribe({
            seq: next.seq,
            startSample: next.startSample,
            wavBase64: next.wavBase64,
          });
          this.consecutiveFailures = 0;
          if (this.stopped) break;
          const text = result.text.trim();
          if (text.length > 0) {
            this.channels.emit({ type: 'final', text, at: Date.now() });
          }
        } catch (error) {
          if (this.stopped) break;
          this.consecutiveFailures += 1;
          const described = error instanceof ApiRequestError ? error : null;

          if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            this.channels.emit({
              type: 'error',
              error: captureError('CONNECTION_FAILED', {
                message:
                  described?.message ?? 'Transcription stopped after several failed chunks in a row.',
                hint:
                  described?.code === 'AI_RATE_LIMITED' || described?.code === 'AI_BUDGET_EXHAUSTED'
                    ? 'The free allowance is used up. The transcript captured so far is still here; start again later or switch to Browser speech.'
                    : 'Check your network connection, then start assistance again.',
                retryable: true,
              }),
            });
            this.queue.clear();
            break;
          }

          // Recoverable: report it, keep the session alive, drop this chunk only.
          if (described !== null) {
            this.channels.emit({
              type: 'error',
              error: captureError('CONNECTION_FAILED', {
                message: described.message,
                hint: 'One audio chunk was lost. SpeakFlow is still listening.',
                retryable: true,
              }),
            });
          }
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  stop(): void {
    this.stopped = true;
    this.channels = null;
    this.queue.clear();

    if (this.processor !== null) {
      this.processor.onaudioprocess = null;
      try {
        this.processor.disconnect();
      } catch {
        // already disconnected
      }
      this.processor = null;
    }
    try {
      this.source?.disconnect();
    } catch {
      // already disconnected
    }
    this.source = null;
    try {
      this.sink?.disconnect();
    } catch {
      // already disconnected
    }
    this.sink = null;
    void this.context?.close().catch(() => undefined);
    this.context = null;
    this.assembler.reset();
  }

  /** True when a known audio gap makes the current context discontinuous. */
  get contextInterrupted(): boolean {
    return this.interrupted;
  }
}

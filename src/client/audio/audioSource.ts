import { captureError, type CaptureError } from '../../shared/errors';

/**
 * Audio acquisition and verification.
 *
 * SpeakFlow never shows a "Connected" state on the strength of a permission
 * prompt alone: the stream must contain an audio track AND that track must
 * actually carry signal. Silent tab-audio is the most common real-world failure
 * (the user forgets "Also share tab audio"), so it gets its own error code and
 * message.
 */

export type CaptureKind = 'tab' | 'system' | 'microphone';

export interface AudioCapture {
  stream: MediaStream;
  kind: CaptureKind;
  stop: () => void;
}

export function isTabAudioSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices === 'object' &&
    navigator.mediaDevices !== null &&
    typeof navigator.mediaDevices.getDisplayMedia === 'function'
  );
}

export function isMicrophoneSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices === 'object' &&
    navigator.mediaDevices !== null &&
    typeof navigator.mediaDevices.getUserMedia === 'function'
  );
}

export function isBrowserSpeechSupported(): boolean {
  if (typeof window === 'undefined') return false;
  const candidate = window as unknown as {
    SpeechRecognition?: unknown;
    webkitSpeechRecognition?: unknown;
  };
  return candidate.SpeechRecognition !== undefined || candidate.webkitSpeechRecognition !== undefined;
}

function stopAllTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

/**
 * Capture audio from the browser's screen/window picker.
 *
 * `tab` and `system` use the same API and differ only in what the user is told
 * to pick, which is not cosmetic: on Windows Chrome the picker offers a
 * **"Share system audio"** checkbox when a screen or window is chosen, and that
 * is the only supported way for a web app to hear a DESKTOP call (Zoom, Teams,
 * Discord, Slack desktop). No companion application or native toolchain is
 * required, but the user must tick that box - and if they only ever pick a tab
 * they will never see it.
 */
async function captureDisplayAudio(kind: 'tab' | 'system'): Promise<AudioCapture> {
  if (!isTabAudioSupported()) throw captureError('NO_DISPLAY_MEDIA');

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
    });
  } catch (error) {
    throw describeCaptureFailure(error);
  }

  for (const track of stream.getVideoTracks()) {
    track.stop();
    stream.removeTrack(track);
  }

  if (stream.getAudioTracks().length === 0) {
    stopAllTracks(stream);
    throw captureError('NO_AUDIO_TRACK', {
      hint:
        kind === 'system'
          ? 'Pick "Entire Screen" (or a window) in the Chrome picker and tick "Share system audio" at the bottom. A tab on its own does not carry desktop-app audio.'
          : 'When you pick a tab in Chrome, tick "Also share tab audio" at the bottom of the picker.',
    });
  }

  return { stream, kind, stop: () => stopAllTracks(stream) };
}

/**
 * Capture audio from a browser tab (or the whole system, depending on what the
 * user picks in the Chrome picker). Video is requested only because Chrome
 * requires it to show the picker, and is stopped immediately afterwards.
 */
export async function captureTabAudio(): Promise<AudioCapture> {
  return captureDisplayAudio('tab');
}

/**
 * Capture everything the machine plays - the route to desktop-app call audio.
 *
 * Honest limits: Chrome only offers the system-audio checkbox on Windows (and
 * ChromeOS), only when a screen or window is selected, and apps using
 * exclusive-mode audio or protected content will not appear. That is why the
 * UI describes this as a Windows route rather than "desktop capture".
 */
export async function captureSystemAudio(): Promise<AudioCapture> {
  return captureDisplayAudio('system');
}

export async function captureMicrophone(): Promise<AudioCapture> {
  if (!isMicrophoneSupported()) throw captureError('UNSUPPORTED_BROWSER');

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
      video: false,
    });
    if (stream.getAudioTracks().length === 0) {
      stopAllTracks(stream);
      throw captureError('NO_AUDIO_TRACK');
    }
    return { stream, kind: 'microphone', stop: () => stopAllTracks(stream) };
  } catch (error) {
    throw describeCaptureFailure(error);
  }
}

/**
 * Samples the stream for ~1s and reports whether real signal is present.
 * Called between permission grant and the "Listening" state.
 */
export async function verifyAudioIsUsable(
  stream: MediaStream,
  options: { durationMs?: number; threshold?: number } = {},
): Promise<{ ok: boolean; peak: number }> {
  const durationMs = options.durationMs ?? 1100;
  const threshold = options.threshold ?? 0.0035;

  if (stream.getAudioTracks().length === 0) return { ok: false, peak: 0 };

  const AudioContextCtor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (AudioContextCtor === undefined) {
    // Cannot measure; do not block the user over a missing API.
    return { ok: true, peak: 0 };
  }

  const context = new AudioContextCtor();
  try {
    if (context.state === 'suspended') await context.resume();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.4;
    source.connect(analyser);

    const buffer = new Float32Array(analyser.fftSize);
    let peak = 0;
    const deadline = performance.now() + durationMs;

    while (performance.now() < deadline) {
      analyser.getFloatTimeDomainData(buffer);
      let sum = 0;
      for (let i = 0; i < buffer.length; i += 1) {
        const value = buffer[i] ?? 0;
        sum += value * value;
      }
      const rms = Math.sqrt(sum / buffer.length);
      if (rms > peak) peak = rms;
      await new Promise((resolve) => setTimeout(resolve, 70));
    }

    source.disconnect();
    return { ok: peak >= threshold, peak };
  } finally {
    await context.close().catch(() => undefined);
  }
}

/** Live level for the meter in the UI (0..1). */
export class AudioLevelMonitor {
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private frame: number | null = null;
  private buffer: Float32Array<ArrayBuffer> | null = null;

  constructor(private readonly onLevel: (level: number) => void) {}

  start(stream: MediaStream): void {
    this.stop();
    if (stream.getAudioTracks().length === 0) return;

    const AudioContextCtor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (AudioContextCtor === undefined) return;

    const context = new AudioContextCtor();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.65;
    source.connect(analyser);

    this.context = context;
    this.source = source;
    this.analyser = analyser;
    this.buffer = new Float32Array(analyser.fftSize);
    void context.resume().catch(() => undefined);

    const tick = (): void => {
      const analyserNode = this.analyser;
      const data = this.buffer;
      if (analyserNode === null || data === null) return;
      analyserNode.getFloatTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i += 1) {
        const value = data[i] ?? 0;
        sum += value * value;
      }
      const rms = Math.sqrt(sum / data.length);
      // sqrt curve makes quiet speech visible without pinning the meter.
      this.onLevel(Math.min(1, Math.sqrt(rms) * 3.4));
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  stop(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.source?.disconnect();
    this.source = null;
    this.analyser = null;
    this.buffer = null;
    void this.context?.close().catch(() => undefined);
    this.context = null;
    this.onLevel(0);
  }
}

/** Map a thrown DOMException (or our own error) to user-facing guidance. */
export function describeCaptureFailure(error: unknown): CaptureError {
  if (typeof error === 'object' && error !== null && 'code' in error && 'retryable' in error) {
    return error as CaptureError;
  }

  const name = error instanceof Error ? error.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return captureError('PERMISSION_DENIED');
    case 'AbortError':
      return captureError('PERMISSION_DENIED', {
        message: 'Audio sharing was cancelled.',
        hint: 'Try again and pick the meeting tab, ticking "Also share tab audio".',
      });
    case 'NotFoundError':
    case 'OverconstrainedError':
      return captureError('NO_AUDIO_TRACK', {
        message: 'No microphone or audio device was found.',
        hint: 'Connect a microphone or headset and try again.',
      });
    case 'NotSupportedError':
    case 'TypeError':
      return captureError('NO_DISPLAY_MEDIA');
    case 'NotReadableError':
      return captureError('UNKNOWN', {
        message: 'The audio device is busy and could not be read.',
        hint: 'Close other apps using the microphone and try again.',
      });
    default:
      return captureError('UNKNOWN');
  }
}

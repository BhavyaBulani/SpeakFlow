// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CAPTURE_ERROR_CODES,
  CAPTURE_ERROR_MAP,
  captureError,
} from '../src/shared/errors';
import {
  captureMicrophone,
  captureSystemAudio,
  captureTabAudio,
  describeCaptureFailure,
  isMicrophoneSupported,
  isTabAudioSupported,
  verifyAudioIsUsable,
} from '../src/client/audio/audioSource';

/**
 * Acceptance criteria 4, 5 and 15 live here:
 *   4. Denied permissions produce useful recovery instructions.
 *   5. Unsupported audio sources are reported honestly.
 *  15. Capture stops and audio resources are released when the session ends.
 *
 * These are the failure paths users actually hit, and none of them were covered
 * before — the browser E2E can only exercise the happy path.
 */

function fakeStream(options: { audio?: boolean; video?: boolean } = {}) {
  const tracks: Array<{ kind: string; stop: ReturnType<typeof vi.fn> }> = [];
  const audioTracks: typeof tracks = [];
  const videoTracks: typeof tracks = [];

  if (options.audio !== false) {
    const track = { kind: 'audio', stop: vi.fn() };
    tracks.push(track);
    audioTracks.push(track);
  }
  if (options.video === true) {
    const track = { kind: 'video', stop: vi.fn() };
    tracks.push(track);
    videoTracks.push(track);
  }

  return {
    stream: {
      getTracks: () => tracks,
      getAudioTracks: () => audioTracks,
      getVideoTracks: () => videoTracks,
      removeTrack: vi.fn(),
    } as unknown as MediaStream,
    tracks,
    audioTracks,
    videoTracks,
  };
}

function domError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('capture error contract', () => {
  it('has a non-empty message and hint for every error code', () => {
    for (const code of CAPTURE_ERROR_CODES) {
      const shaped = captureError(code);
      expect(shaped.code).toBe(code);
      expect(shaped.message.length).toBeGreaterThan(10);
      // A user who sees an error needs to know what to do next.
      expect(shaped.hint?.length ?? 0).toBeGreaterThan(10);
    }
  });

  it('marks permission denial as retryable and unsupported browsers as not', () => {
    expect(CAPTURE_ERROR_MAP.PERMISSION_DENIED.retryable).toBe(true);
    expect(CAPTURE_ERROR_MAP.UNSUPPORTED_BROWSER.retryable).toBe(false);
    expect(CAPTURE_ERROR_MAP.NO_DISPLAY_MEDIA.retryable).toBe(false);
  });

  it('tells the user to tick "share tab audio" when no audio track arrived', () => {
    expect(CAPTURE_ERROR_MAP.NO_AUDIO_TRACK.hint).toMatch(/also share tab audio/i);
  });
});

describe('describeCaptureFailure maps real DOMExceptions (criterion 4)', () => {
  it('maps a denied prompt to PERMISSION_DENIED with recovery steps', () => {
    const result = describeCaptureFailure(domError('NotAllowedError'));
    expect(result.code).toBe('PERMISSION_DENIED');
    expect(result.retryable).toBe(true);
    expect(result.hint).toMatch(/allow|padlock|address bar/i);
  });

  it('maps a cancelled share picker to an actionable message', () => {
    const result = describeCaptureFailure(domError('AbortError'));
    expect(result.code).toBe('PERMISSION_DENIED');
    expect(result.hint).toMatch(/pick the meeting tab/i);
  });

  it('maps a missing device to NO_AUDIO_TRACK', () => {
    expect(describeCaptureFailure(domError('NotFoundError')).code).toBe('NO_AUDIO_TRACK');
    expect(describeCaptureFailure(domError('OverconstrainedError')).code).toBe('NO_AUDIO_TRACK');
  });

  it('maps a busy device to UNKNOWN with a "close other apps" hint', () => {
    const result = describeCaptureFailure(domError('NotReadableError'));
    expect(result.code).toBe('UNKNOWN');
    expect(result.hint).toMatch(/close other apps/i);
  });

  it('reports an unsupported browser honestly rather than blaming the user', () => {
    const result = describeCaptureFailure(domError('NotSupportedError'));
    expect(result.code).toBe('NO_DISPLAY_MEDIA');
    expect(result.retryable).toBe(false);
    expect(result.hint).toMatch(/chrome|microphone/i);
  });

  it('passes an already-shaped CaptureError straight through', () => {
    const shaped = captureError('SILENT_AUDIO');
    expect(describeCaptureFailure(shaped)).toBe(shaped);
  });

  it('falls back to UNKNOWN for something unexpected, never throwing', () => {
    expect(describeCaptureFailure(new Error('???')).code).toBe('UNKNOWN');
    expect(describeCaptureFailure(null).code).toBe('UNKNOWN');
    expect(describeCaptureFailure('a string').code).toBe('UNKNOWN');
  });
});

describe('capability detection (criterion 5)', () => {
  it('reports tab audio unsupported when getDisplayMedia is absent', () => {
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => undefined } });
    expect(isTabAudioSupported()).toBe(false);
    expect(isMicrophoneSupported()).toBe(true);
  });

  it('reports everything unsupported when mediaDevices is missing', () => {
    vi.stubGlobal('navigator', {});
    expect(isTabAudioSupported()).toBe(false);
    expect(isMicrophoneSupported()).toBe(false);
  });

  it('refuses to request tab capture on an unsupported browser', async () => {
    vi.stubGlobal('navigator', {});
    await expect(captureTabAudio()).rejects.toMatchObject({ code: 'NO_DISPLAY_MEDIA' });
  });
});

describe('tab capture hygiene (criteria 5 and 15)', () => {
  it('stops the video track Chrome forces us to request, keeping only audio', async () => {
    const fake = fakeStream({ audio: true, video: true });
    vi.stubGlobal('navigator', {
      mediaDevices: { getDisplayMedia: vi.fn(async () => fake.stream) },
    });

    const capture = await captureTabAudio();
    expect(capture.kind).toBe('tab');

    // Screen video is useless for transcription, so it must be stopped at once.
    expect(fake.videoTracks[0]?.stop).toHaveBeenCalled();
    expect(fake.stream.removeTrack).toHaveBeenCalled();
    expect(fake.audioTracks[0]?.stop).not.toHaveBeenCalled();

    capture.stop();
    // Releasing the capture must stop the remaining audio track.
    expect(fake.audioTracks[0]?.stop).toHaveBeenCalled();
  });

  it('rejects a tab share that contains no audio track', async () => {
    const fake = fakeStream({ audio: false, video: true });
    vi.stubGlobal('navigator', {
      mediaDevices: { getDisplayMedia: vi.fn(async () => fake.stream) },
    });

    await expect(captureTabAudio()).rejects.toMatchObject({ code: 'NO_AUDIO_TRACK' });
    // Nothing may be left running after a failure.
    expect(fake.tracks.every((track) => track.stop.mock.calls.length > 0)).toBe(true);
  });

  it('surfaces a denied picker as PERMISSION_DENIED', async () => {
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getDisplayMedia: vi.fn(async () => {
          throw domError('NotAllowedError');
        }),
      },
    });
    await expect(captureTabAudio()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});

describe('system audio capture (desktop-app route)', () => {
  it('reports kind "system" so the UI and error hints differ from tab mode', async () => {
    const fake = fakeStream({ audio: true, video: true });
    vi.stubGlobal('navigator', {
      mediaDevices: { getDisplayMedia: vi.fn(async () => fake.stream) },
    });

    const capture = await captureSystemAudio();
    expect(capture.kind).toBe('system');
    // Video is still stopped immediately: only audio is wanted.
    expect(fake.videoTracks[0]?.stop).toHaveBeenCalled();

    capture.stop();
    expect(fake.tracks.every((track) => track.stop.mock.calls.length > 0)).toBe(true);
  });

  it('tells the user to tick "Share system audio", not the tab-audio box', async () => {
    // A stream with no audio track is exactly what you get when the user shares a
    // screen but forgets the checkbox - the most common real failure here.
    const fake = fakeStream({ audio: false, video: true });
    vi.stubGlobal('navigator', {
      mediaDevices: { getDisplayMedia: vi.fn(async () => fake.stream) },
    });

    await expect(captureSystemAudio()).rejects.toMatchObject({
      code: 'NO_AUDIO_TRACK',
      hint: expect.stringContaining('Share system audio'),
    });
  });

  it('refuses system capture on an unsupported browser', async () => {
    vi.stubGlobal('navigator', {});
    await expect(captureSystemAudio()).rejects.toMatchObject({ code: 'NO_DISPLAY_MEDIA' });
  });
});

describe('microphone capture hygiene (criterion 15)', () => {
  it('releases the microphone track on stop', async () => {
    const fake = fakeStream({ audio: true });
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn(async () => fake.stream) },
    });

    const capture = await captureMicrophone();
    expect(capture.kind).toBe('microphone');
    capture.stop();
    expect(fake.audioTracks[0]?.stop).toHaveBeenCalled();
  });

  it('rejects a stream with no audio track and stops what it got', async () => {
    const fake = fakeStream({ audio: false });
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn(async () => fake.stream) },
    });
    await expect(captureMicrophone()).rejects.toMatchObject({ code: 'NO_AUDIO_TRACK' });
  });

  it('reports a busy device rather than hanging', async () => {
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn(async () => {
          throw domError('NotReadableError');
        }),
      },
    });
    await expect(captureMicrophone()).rejects.toMatchObject({ code: 'UNKNOWN' });
  });
});

describe('audio verification gates "Listening" (criterion 6)', () => {
  it('refuses a stream with no audio track instead of claiming it is usable', async () => {
    const fake = fakeStream({ audio: false });
    const result = await verifyAudioIsUsable(fake.stream);
    expect(result.ok).toBe(false);
    expect(result.peak).toBe(0);
  });
});

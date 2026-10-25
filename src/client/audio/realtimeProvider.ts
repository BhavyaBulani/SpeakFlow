import { captureError } from '../../shared/errors';
import { ApiRequestError } from '../lib/api';
import type { ProviderContext, TranscriptionProvider } from './types';

/**
 * Real streaming transcription over WebRTC against the OpenAI Realtime API.
 *
 * Flow (verified against the published OpenAPI spec):
 *   1. our backend mints an ephemeral client secret (`POST /v1/realtime/client_secrets`)
 *   2. browser creates an RTCPeerConnection, adds the audio track and a data channel
 *   3. the SDP offer is POSTed to `POST /v1/realtime/calls` with the ephemeral key
 *   4. transcript events arrive on the data channel as JSON
 *
 * Audio never passes through our server, which is what keeps latency low.
 */

const MAX_RECONNECT_ATTEMPTS = 3;

interface RealtimeEvent {
  type?: unknown;
  item_id?: unknown;
  delta?: unknown;
  transcript?: unknown;
  error?: { message?: unknown };
}

function waitForIceGathering(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (): void => {
      pc.removeEventListener('icegatheringstatechange', onChange);
      clearTimeout(timer);
      resolve();
    };
    const onChange = (): void => {
      if (pc.iceGatheringState === 'complete') finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    pc.addEventListener('icegatheringstatechange', onChange);
  });
}

function tokenFailureToCaptureError(error: unknown) {
  if (error instanceof ApiRequestError) {
    if (error.code === 'PROVIDER_NOT_CONFIGURED') return captureError('PROVIDER_NOT_CONFIGURED');
    if (error.code === 'UNAUTHORIZED') {
      return captureError('TOKEN_FAILED', {
        message: 'The server rejected this workspace token.',
        hint: 'Open Settings and check the access token.',
        retryable: false,
      });
    }
    return captureError('TOKEN_FAILED', { message: error.message });
  }
  return captureError('TOKEN_FAILED');
}

export class RealtimeTranscriptionProvider implements TranscriptionProvider {
  readonly id = 'openai-realtime' as const;
  readonly label = 'OpenAI streaming';
  readonly note =
    'Audio streams directly from this browser to OpenAI over WebRTC. SpeakFlow never records or stores it.';
  readonly consumesCapturedStream = true;

  private pc: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private context: ProviderContext | null = null;
  private stopped = true;
  private attempt = 0;
  private reconnectTimer: number | null = null;
  private partialByItem = new Map<string, string>();

  async start(context: ProviderContext): Promise<void> {
    this.context = context;
    this.stopped = false;
    this.attempt = 0;
    await this.connect(context);
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.closePeer();
    this.partialByItem.clear();
    this.context = null;
  }

  private closePeer(): void {
    if (this.dataChannel !== null) {
      this.dataChannel.onmessage = null;
      this.dataChannel.onopen = null;
      this.dataChannel.onclose = null;
      this.dataChannel.onerror = null;
      try {
        this.dataChannel.close();
      } catch {
        // already closed
      }
      this.dataChannel = null;
    }
    if (this.pc !== null) {
      this.pc.onconnectionstatechange = null;
      try {
        this.pc.close();
      } catch {
        // already closed
      }
      this.pc = null;
    }
  }

  private async connect(context: ProviderContext): Promise<void> {
    if (this.stopped || context.signal.aborted) return;
    context.emit({ type: 'status', status: 'connecting' });

    let tokenResponse: Awaited<ReturnType<ProviderContext['getRealtimeToken']>>;
    try {
      tokenResponse = await context.getRealtimeToken();
    } catch (error) {
      context.emit({ type: 'error', error: tokenFailureToCaptureError(error) });
      return;
    }

    if (this.stopped || context.signal.aborted) return;

    const stream = context.stream;
    const track = stream?.getAudioTracks()[0];
    if (stream === null || track === undefined) {
      context.emit({ type: 'error', error: captureError('NO_AUDIO_TRACK') });
      return;
    }

    const pc = new RTCPeerConnection({ iceServers: [] });
    this.pc = pc;
    pc.addTrack(track, stream);

    const dataChannel = pc.createDataChannel(tokenResponse.transport.dataChannel, { ordered: true });
    this.dataChannel = dataChannel;

    dataChannel.onmessage = (event: MessageEvent) => {
      this.handleMessage(event, context);
    };
    dataChannel.onopen = () => {
      this.attempt = 0;
      context.emit({ type: 'status', status: 'listening' });
    };
    dataChannel.onclose = () => {
      if (!this.stopped) this.scheduleReconnect(context);
    };

    pc.onconnectionstatechange = () => {
      if (this.stopped) return;
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        this.scheduleReconnect(context);
      }
    };

    track.addEventListener(
      'ended',
      () => {
        if (this.stopped) return;
        context.emit({ type: 'error', error: captureError('STREAM_ENDED') });
      },
      { once: true },
    );

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIceGathering(pc, 1500);

      const sdp = pc.localDescription?.sdp;
      if (typeof sdp !== 'string' || sdp.length === 0) {
        throw new Error('no local SDP');
      }

      const response = await fetch(tokenResponse.transport.sdpUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenResponse.token}`,
          'Content-Type': 'application/sdp',
        },
        body: sdp,
        signal: context.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`SDP exchange failed (${response.status}) ${detail.slice(0, 120)}`);
      }

      const answerSdp = await response.text();
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    } catch (error) {
      if (this.stopped || context.signal.aborted) return;
      this.closePeer();
      this.scheduleReconnect(context, error);
    }
  }

  private scheduleReconnect(context: ProviderContext, cause?: unknown): void {
    if (this.stopped || this.reconnectTimer !== null) return;
    this.closePeer();

    if (this.attempt >= MAX_RECONNECT_ATTEMPTS) {
      context.emit({
        type: 'error',
        error: captureError('CONNECTION_FAILED', {
          message: 'Lost the connection to the transcription service.',
          hint:
            cause instanceof Error
              ? `${cause.message.slice(0, 120)}. Check your network, then start again.`
              : 'Check your network, then start again.',
        }),
      });
      return;
    }

    this.attempt += 1;
    const delay = Math.min(8000, 900 * 2 ** (this.attempt - 1));
    context.emit({
      type: 'status',
      status: 'reconnecting',
      detail: `Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.attempt} of ${MAX_RECONNECT_ATTEMPTS})`,
    });

    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect(context);
    }, delay);
  }

  private handleMessage(event: MessageEvent, context: ProviderContext): void {
    if (typeof event.data !== 'string') return;

    let payload: RealtimeEvent;
    try {
      payload = JSON.parse(event.data) as RealtimeEvent;
    } catch {
      return;
    }

    const type = typeof payload.type === 'string' ? payload.type : '';
    const itemId = typeof payload.item_id === 'string' ? payload.item_id : 'current';

    // Suffix matching keeps this working across both the `input_audio_transcription.*`
    // and `conversation.item.input_audio_transcription.*` event spellings.
    if (type.endsWith('input_audio_transcription.delta')) {
      const delta = typeof payload.delta === 'string' ? payload.delta : '';
      const accumulated = (this.partialByItem.get(itemId) ?? '') + delta;
      this.partialByItem.set(itemId, accumulated);
      if (accumulated.trim().length > 0) {
        context.emit({ type: 'partial', text: accumulated.trim(), at: Date.now() });
      }
      return;
    }

    if (type.endsWith('input_audio_transcription.completed')) {
      const stored = this.partialByItem.get(itemId) ?? '';
      const transcript =
        typeof payload.transcript === 'string' && payload.transcript.trim().length > 0
          ? payload.transcript.trim()
          : stored.trim();
      this.partialByItem.delete(itemId);
      if (transcript.length > 0) {
        context.emit({ type: 'final', text: transcript, at: Date.now() });
      }
      return;
    }

    if (type.endsWith('input_audio_transcription.failed')) {
      this.partialByItem.delete(itemId);
      context.emit({
        type: 'error',
        error: captureError('CONNECTION_FAILED', {
          message: 'That utterance could not be transcribed.',
          hint: 'SpeakFlow is still listening - carry on speaking.',
        }),
      });
      return;
    }

    if (type === 'input_audio_buffer.speech_started') {
      context.emit({ type: 'speech-start', at: Date.now() });
      return;
    }

    if (type === 'input_audio_buffer.speech_stopped') {
      context.emit({ type: 'speech-end', at: Date.now() });
      return;
    }

    if (type === 'error') {
      const message = typeof payload.error?.message === 'string' ? payload.error.message : 'Realtime error';
      context.emit({
        type: 'error',
        error: captureError('CONNECTION_FAILED', { message: message.slice(0, 200) }),
      });
    }
  }
}

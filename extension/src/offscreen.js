/**
 * Offscreen audio pipeline for SpeakFlow AI.
 *
 * Does four things and nothing else:
 *   1. turns the tab-capture stream id into a real MediaStream
 *   2. keeps the meeting audible (tabCapture mutes the tab for the user)
 *   3. opens a WebRTC session against the provider with an ephemeral token
 *   4. relays transcription events to the service worker
 *
 * It never generates replies and never sees the permanent provider key.
 */

const MAX_RECONNECTS = 3;
const SILENCE_THRESHOLD = 0.0035;

let session = null;
let reconnectAttempts = 0;

function emit(event) {
  chrome.runtime.sendMessage({ target: 'background', type: 'capture:event', event }).catch(() => undefined);
}

function fail(code, message, hint, retryable = true) {
  emit({ type: 'error', error: { code, message, retryable, ...(hint ? { hint } : {}) } });
}

function status(value, detail) {
  emit({ type: 'status', status: value, ...(detail ? { detail } : {}) });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.target !== 'offscreen') return false;
  if (message.type === 'capture:start') {
    void start(message).catch((error) => {
      console.error('[speakflow-offscreen] start failed', error);
      fail('CONNECTION_FAILED', 'Audio pipeline failed to start.', String(error?.message ?? error));
    });
  }
  if (message.type === 'capture:stop') stop('Stopped by user.');
  return false;
});

async function start({ streamId, settings }) {
  stop(null);

  const media = await navigator.mediaDevices
    .getUserMedia({
      audio: {
        // Legacy constraints are the documented way to attach a tab-capture id.
        mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId },
      },
      video: false,
    })
    .catch((error) => {
      throw new Error(`getUserMedia failed: ${error?.name ?? error}`);
    });

  const audioTrack = media.getAudioTracks()[0];
  if (!audioTrack) {
    media.getTracks().forEach((track) => track.stop());
    fail('NO_AUDIO_TRACK', 'The selected tab has no audio track.', 'Pick the tab that is playing the meeting audio.');
    return;
  }

  // tabCapture silences the tab for the user unless we route it back out.
  const playback = new AudioContext();
  let playbackNode = null;
  try {
    playbackNode = playback.createMediaStreamSource(media);
    playbackNode.connect(playback.destination);
    if (playback.state === 'suspended') await playback.resume();
  } catch (error) {
    console.warn('[speakflow-offscreen] playback restore failed', error);
  }

  session = { media, playback, playbackNode, pc: null, channel: null, token: null, closed: false, settings };
  reconnectAttempts = 0;

  await connect(session);
}

function closePeer(target) {
  if (target.channel) {
    try {
      target.channel.close();
    } catch {
      /* already closed */
    }
    target.channel = null;
  }
  if (target.pc) {
    target.pc.onconnectionstatechange = null;
    try {
      target.pc.close();
    } catch {
      /* already closed */
    }
    target.pc = null;
  }
}

function stop(detail) {
  const target = session;
  if (!target) return;
  session = null;
  target.closed = true;
  closePeer(target);
  target.media.getTracks().forEach((track) => track.stop());
  try {
    target.playbackNode?.disconnect();
    void target.playback.close();
  } catch {
    /* ignore */
  }
  if (detail) status('stopped', detail);
}

async function fetchToken(settings) {
  const base = String(settings.backendUrl ?? '').replace(/\/+$/, '');
  const response = await fetch(`${base}/realtime/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(settings.accessToken ? { Authorization: `Bearer ${settings.accessToken}` } : {}),
    },
    body: '{}',
  });

  if (!response.ok) {
    let code = 'TOKEN_FAILED';
    let message = `The SpeakFlow server returned ${response.status} when issuing a streaming token.`;
    try {
      const body = await response.json();
      if (body?.error?.code) code = body.error.code;
      if (body?.error?.message) message = body.error.message;
    } catch {
      /* non-JSON error */
    }
    throw Object.assign(new Error(message), { speakflowCode: code });
  }

  const payload = await response.json();
  if (typeof payload?.token !== 'string' || payload.token.length === 0) {
    throw Object.assign(new Error('The server returned an empty streaming token.'), {
      speakflowCode: 'TOKEN_FAILED',
    });
  }
  return payload;
}

function waitForIceGathering(pc, timeoutMs) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      pc.removeEventListener('icegatheringstatechange', onChange);
      clearTimeout(timer);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    pc.addEventListener('icegatheringstatechange', onChange);
  });
}

async function connect(target) {
  if (target.closed || session !== target) return;
  status('connecting');

  let tokenPayload;
  try {
    tokenPayload = await fetchToken(target.settings);
    target.token = tokenPayload;
  } catch (error) {
    const code = error?.speakflowCode ?? 'TOKEN_FAILED';
    if (code === 'PROVIDER_NOT_CONFIGURED') {
      fail(
        'PROVIDER_NOT_CONFIGURED',
        'Live streaming transcription is not configured on the server.',
        'Add OPENAI_API_KEY to the backend .env, then restart the server.',
        false,
      );
    } else if (code === 'UNAUTHORIZED') {
      fail(
        'TOKEN_FAILED',
        'The SpeakFlow server rejected the workspace access token.',
        'Open the extension popup and check the access token matches APP_ACCESS_TOKEN on the server.',
        false,
      );
    } else {
      fail('TOKEN_FAILED', error?.message ?? 'Could not get a streaming token.');
    }
    return;
  }

  if (target.closed || session !== target) return;

  const pc = new RTCPeerConnection({ iceServers: [] });
  target.pc = pc;
  pc.addTrack(target.media.getAudioTracks()[0], target.media);

  const channel = pc.createDataChannel(tokenPayload.transport?.dataChannel ?? 'oai-events', { ordered: true });
  target.channel = channel;

  let partial = '';
  channel.onmessage = (event) => {
    if (typeof event.data !== 'string') return;
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    const type = typeof payload?.type === 'string' ? payload.type : '';

    if (type.endsWith('input_audio_transcription.delta')) {
      partial += typeof payload.delta === 'string' ? payload.delta : '';
      if (partial.trim().length > 0) emit({ type: 'partial', text: partial.trim(), at: Date.now() });
      return;
    }
    if (type.endsWith('input_audio_transcription.completed')) {
      const finalText =
        typeof payload.transcript === 'string' && payload.transcript.trim().length > 0
          ? payload.transcript.trim()
          : partial.trim();
      partial = '';
      if (finalText.length > 0) emit({ type: 'final', text: finalText, at: Date.now() });
      return;
    }
    if (type.endsWith('input_audio_transcription.failed')) {
      partial = '';
      fail('CONNECTION_FAILED', 'That utterance could not be transcribed.', 'SpeakFlow is still listening.');
      return;
    }
    if (type === 'input_audio_buffer.speech_started') {
      emit({ type: 'speech-start', at: Date.now() });
      return;
    }
    if (type === 'input_audio_buffer.speech_stopped') {
      emit({ type: 'speech-end', at: Date.now() });
      return;
    }
    if (type === 'error') {
      fail('CONNECTION_FAILED', String(payload?.error?.message ?? 'Realtime error').slice(0, 200));
    }
  };

  channel.onopen = () => {
    reconnectAttempts = 0;
    status('listening');
    void warnIfSilent(target);
  };
  channel.onclose = () => {
    if (!target.closed) void scheduleReconnect(target);
  };
  pc.onconnectionstatechange = () => {
    if (target.closed) return;
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      void scheduleReconnect(target);
    }
  };

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc, 1500);

    const sdpUrl = tokenPayload.transport?.sdpUrl;
    if (typeof sdpUrl !== 'string') throw new Error('The server did not provide an SDP endpoint.');

    const response = await fetch(sdpUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenPayload.token}`,
        'Content-Type': 'application/sdp',
      },
      body: pc.localDescription?.sdp ?? offer.sdp,
    });

    if (!response.ok) {
      throw new Error(`SDP exchange failed (${response.status}).`);
    }
    await pc.setRemoteDescription({ type: 'answer', sdp: await response.text() });
  } catch (error) {
    if (target.closed) return;
    closePeer(target);
    await scheduleReconnect(target, error);
  }
}

/** Report silence honestly instead of claiming "Listening" on a muted tab. */
async function warnIfSilent(target) {
  try {
    const analyser = target.playback.createAnalyser();
    analyser.fftSize = 512;
    target.playbackNode?.connect(analyser);
    const data = new Float32Array(analyser.fftSize);
    const deadline = performance.now() + 1500;
    let peak = 0;
    while (performance.now() < deadline) {
      analyser.getFloatTimeDomainData(data);
      for (let i = 0; i < data.length; i += 1) peak = Math.max(peak, Math.abs(data[i]));
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!target.closed && peak < SILENCE_THRESHOLD) {
      status(
        'listening',
        'No sound detected yet from this tab. Check the meeting tab is not muted and someone is speaking.',
      );
    }
  } catch {
    /* metering is advisory only */
  }
}

async function scheduleReconnect(target, cause) {
  if (target.closed || session !== target) return;
  closePeer(target);

  if (reconnectAttempts >= MAX_RECONNECTS) {
    fail(
      'CONNECTION_FAILED',
      'Lost the connection to the transcription service.',
      cause?.message ? `${String(cause.message).slice(0, 120)} Check your network, then start again.` : undefined,
    );
    return;
  }
  reconnectAttempts += 1;
  const delay = Math.min(8000, 900 * 2 ** (reconnectAttempts - 1));
  status('reconnecting', `Reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts} of ${MAX_RECONNECTS})`);
  await new Promise((resolve) => setTimeout(resolve, delay));
  await connect(target);
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { captureError, type CaptureError } from '../../shared/errors';
import {
  REFINED_POLICY,
  createSequencer,
  decideProvisional,
  decideRefined,
  summarizeLatency,
  type LatencySummary,
} from '../../shared/replyPipeline';
import { lastFinalSegments, looksUnfinished } from '../../shared/transcript';
import type {
  AppConfig,
  PipelineStage,
  RefineDirective,
  ReplyIntent,
  ReplyResult,
  ReplyStage,
  ReplyTone,
  SessionStatus,
  TranscriptSegment,
} from '../../shared/types';
import {
  AudioLevelMonitor,
  captureMicrophone,
  captureSystemAudio,
  captureTabAudio,
  describeCaptureFailure,
  isBrowserSpeechSupported,
  isTabAudioSupported,
  verifyAudioIsUsable,
  type AudioCapture,
} from '../audio/audioSource';
import { BrowserSpeechProvider } from '../audio/browserSpeechProvider';
import { ChunkedSttProvider } from '../audio/chunkedSttProvider';
import { ExtensionBridgeProvider } from '../audio/extensionBridgeProvider';
import { RealtimeTranscriptionProvider } from '../audio/realtimeProvider';
import { SimulatedTranscriptionProvider } from '../audio/simulatedProvider';
import type { ProviderContext, TranscriptionEvent, TranscriptionProvider } from '../audio/types';
import { ApiClient, describeApiError } from '../lib/api';
import type { UserSettings } from '../lib/settings';

/**
 * The live copilot brain on the client side.
 *
 * Owns the audio capture + transcription provider lifecycle, turns transcript
 * events into provisional/refined requests, guarantees a newer reply never
 * loses to an older one, cancels superseded requests, and measures latency.
 *
 * The decision *policy* lives in src/shared/replyPipeline.ts (pure and unit
 * tested). This hook only wires it to React, the network and the microphone.
 */

const MAX_SEGMENTS = 240;
const MAX_PARTIAL_BUFFER = 2000;

export interface RequestError {
  code: string;
  message: string;
}

interface PipelineState {
  sessionId: string | null;
  lastRequestedText: string;
  lastRequestedAt: number;
  requestsThisUtterance: number;
  lastRefinedFor: string;
  inFlight: { controller: AbortController; stage: ReplyStage } | null;
  speechAt: number | null;
  transcriptAt: number | null;
  requestAt: number | null;
  replyAt: number | null;
  partial: string;
  refinedTimer: number | null;
}

function emptyPipeline(): PipelineState {
  return {
    sessionId: null,
    lastRequestedText: '',
    lastRequestedAt: 0,
    requestsThisUtterance: 0,
    lastRefinedFor: '',
    inFlight: null,
    speechAt: null,
    transcriptAt: null,
    requestAt: null,
    replyAt: null,
    partial: '',
    refinedTimer: null,
  };
}

function makeId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `seg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createProvider(providerId: UserSettings['provider']): TranscriptionProvider {
  if (providerId === 'browser-speech') return new BrowserSpeechProvider();
  if (providerId === 'chunked-stt') return new ChunkedSttProvider();
  if (providerId === 'extension-bridge') return new ExtensionBridgeProvider();
  if (providerId === 'simulated') return new SimulatedTranscriptionProvider();
  return new RealtimeTranscriptionProvider();
}

function tokenSource(api: ApiClient): ProviderContext['getRealtimeToken'] {
  return async () => {
    const token = await api.createRealtimeToken();
    return {
      token: token.token,
      expiresAt: token.expiresAt,
      model: token.model,
      transport: {
        sdpUrl: token.transport.sdpUrl,
        dataChannel: token.transport.dataChannel,
        sampleRate: token.transport.sampleRate,
      },
    };
  };
}

/**
 * Binds the chunked provider to the session it was started for.
 *
 * The id is captured per start/resume rather than read from shared state, so a
 * stopped session can never have audio attributed to a newer one.
 */
function chunkSource(api: ApiClient, sessionId: string): NonNullable<ProviderContext['transcribeChunk']> {
  return async (input) => api.transcribeChunk({ sessionId, ...input });
}

export interface UseCopilotSession {
  config: AppConfig | null;
  configError: string | null;
  configNotice: string | null;
  dismissConfigNotice: () => void;
  status: SessionStatus;
  statusDetail: string | null;
  error: CaptureError | null;
  requestError: RequestError | null;
  /** True once audio was lost, so the transcript may have a gap. */
  contextUncertain: boolean;
  /** Derived live pipeline stage, for the status strip. */
  pipelineStage: PipelineStage;
  segments: TranscriptSegment[];
  partial: string;
  reply: ReplyResult | null;
  replyPending: boolean;
  discardedStale: number;
  latency: LatencySummary;
  level: number;
  activeProviderLabel: string | null;
  isActive: boolean;
  start: () => Promise<void>;
  stop: () => void;
  pause: () => void;
  resume: () => Promise<void>;
  regenerate: () => Promise<void>;
  /** Rewrite the current script (simpler/shorter/natural/formal). */
  refine: (directive: RefineDirective) => Promise<void>;
  /**
   * Re-run the current script in a different tone.
   *
   * Takes the tone as an argument rather than reading settings, because React
   * state has not been committed yet at the moment the user clicks.
   */
  applyTone: (tone: ReplyTone) => Promise<void>;
  clearTranscript: () => void;
}

export function useCopilotSession(options: {
  api: ApiClient;
  settings: UserSettings;
}): UseCopilotSession {
  const { api, settings } = options;

  const [config, setConfig] = useState<AppConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [configNotice, setConfigNotice] = useState<string | null>(null);

  const [status, setStatus] = useState<SessionStatus>('idle');
  const [statusDetail, setStatusDetail] = useState<string | null>(null);
  const [error, setError] = useState<CaptureError | null>(null);
  const [requestError, setRequestError] = useState<RequestError | null>(null);
  /**
   * True once audio has been lost in this session.
   *
   * Sticky on purpose: a gap does not un-happen when audio resumes, and a reply
   * built across it is less trustworthy for the rest of the call.
   */
  const [contextUncertain, setContextUncertain] = useState(false);

  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [partial, setPartial] = useState('');
  const [reply, setReply] = useState<ReplyResult | null>(null);
  const [replyPending, setReplyPending] = useState(false);
  const [discardedStale, setDiscardedStale] = useState(0);
  const [latency, setLatency] = useState<LatencySummary>({
    speechToTranscriptMs: null,
    transcriptToRequestMs: null,
    requestToReplyMs: null,
    speechToReplyMs: null,
  });
  const [level, setLevel] = useState(0);
  const [activeProviderLabel, setActiveProviderLabel] = useState<string | null>(null);

  const pipelineRef = useRef<PipelineState>(emptyPipeline());
  const sequencerRef = useRef(createSequencer());
  /**
   * Mirror of `reply` for callbacks that must not be recreated on every reply.
   * `refine` needs the reply currently on screen, and reading state inside a
   * useCallback would capture a stale value.
   */
  const replyRef = useRef<ReplyResult | null>(null);
  const providerRef = useRef<TranscriptionProvider | null>(null);
  const captureRef = useRef<AudioCapture | null>(null);
  const segmentsRef = useRef<TranscriptSegment[]>([]);
  const monitorRef = useRef<AudioLevelMonitor | null>(null);
  const startingRef = useRef(false);
  const settingsRef = useRef(settings);
  const configRef = useRef<AppConfig | null>(null);

  settingsRef.current = settings;
  configRef.current = config;
  replyRef.current = reply;

  useEffect(() => {
    let cancelled = false;
    api
      .getConfig()
      .then((value) => {
        if (cancelled) return;
        setConfig(value);
        setConfigError(null);
        if (!value.aiConfigured) {
          setConfigNotice(
            'The AI provider is not configured on this server, so reply generation and translation are unavailable. Add OPENAI_API_KEY to the server .env (see README), or start the server with MOCK_AI=1 for clearly-labelled mock replies.',
          );
          return;
        }
        // `aiConfigured` only means a provider is SELECTED. For a local model it
        // stays true while nothing is listening on loopback, so the honest
        // question - is it answering? - needs the probe in /api/health.
        void api
          .health()
          .then((health) => {
            if (cancelled) return;
            const model = health.replyModel;
            if (model?.applicable === true && model.reachable === false) {
              setConfigNotice(
                `The local reply model (${model.model}) is not answering, so refined replies will show as Fallback. ${model.detail}`,
              );
            }
          })
          // A failed health check must not be reported as a config error.
          .catch(() => undefined);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setConfigError(describeApiError(err).message);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const updateSegments = useCallback((next: TranscriptSegment[]) => {
    const trimmed = next.length > MAX_SEGMENTS ? next.slice(next.length - MAX_SEGMENTS) : next;
    segmentsRef.current = trimmed;
    setSegments(trimmed);
  }, []);

  const stopMonitor = useCallback(() => {
    monitorRef.current?.stop();
    monitorRef.current = null;
    setLevel(0);
  }, []);

  /** Fire a reply request. Every request gets a version; only the newest wins. */
  const requestReply = useCallback(
    async (
      stage: ReplyStage,
      utterance: string,
      force = false,
      extra?: {
        refine?: RefineDirective | null;
        previousReply?: string | null;
        tone?: ReplyTone;
      },
    ) => {
      const pipeline = pipelineRef.current;
      const sessionId = pipeline.sessionId;
      if (sessionId === null || utterance.trim().length === 0) return;

      if (pipeline.inFlight !== null && (force || pipeline.inFlight.stage === stage)) {
        pipeline.inFlight.controller.abort();
      }

      // A refine is a rewrite of the reply already on screen, so it keeps the
      // same utterance and intent; only the directive is new.
      const replyIntent: ReplyIntent | null = settingsRef.current.replyIntent;

      const version = sequencerRef.current.begin();
      const controller = new AbortController();
      pipeline.requestAt = Date.now();
      pipeline.inFlight = { controller, stage };
      setReplyPending(true);

      try {
        const result = await api.generateReply({
          sessionId,
          stage,
          version,
          utterance,
          recentFinals: lastFinalSegments(segmentsRef.current, configRef.current?.contextWindowTurns ?? 6),
          tone: extra?.tone ?? settingsRef.current.tone,
          userContext: settingsRef.current.userContext,
          utteranceUnfinished: stage === 'provisional' && looksUnfinished(utterance),
          replyIntent,
          refine: extra?.refine ?? null,
          previousReply: extra?.previousReply ?? null,
          signal: controller.signal,
        });

        if (controller.signal.aborted) return;
        if (!sequencerRef.current.isLatest(version)) {
          setDiscardedStale((count) => count + 1);
          return;
        }

        pipeline.replyAt = Date.now();
        setReply(result);
        setRequestError(null);
        setLatency(
          summarizeLatency({
            speechAt: pipeline.speechAt,
            transcriptAt: pipeline.transcriptAt,
            requestAt: pipeline.requestAt,
            replyAt: pipeline.replyAt,
          }),
        );
      } catch (err) {
        const described = describeApiError(err);
        if (described.code === 'REQUEST_ABORTED') return;
        if (described.code === 'PROVIDER_NOT_CONFIGURED') {
          setConfigNotice(described.message);
        } else {
          setRequestError({ code: described.code, message: described.message });
        }
      } finally {
        if (pipeline.inFlight?.controller === controller) {
          pipeline.inFlight = null;
          setReplyPending(false);
        }
      }
    },
    [api],
  );

  const runRefined = useCallback(
    async (utterance: string) => {
      const pipeline = pipelineRef.current;
      const decision = decideRefined({
        utterance,
        lastRefinedFor: pipeline.lastRefinedFor,
        inFlight: pipeline.inFlight !== null,
      });
      if (decision.action === 'skip') return;
      pipeline.lastRefinedFor = utterance;
      await requestReply('refined', utterance);
    },
    [requestReply],
  );

  const scheduleRefined = useCallback(
    (utterance: string) => {
      const pipeline = pipelineRef.current;
      if (utterance.trim().length === 0) return;
      if (pipeline.refinedTimer !== null) clearTimeout(pipeline.refinedTimer);
      pipeline.refinedTimer = window.setTimeout(() => {
        pipelineRef.current.refinedTimer = null;
        void runRefined(utterance);
      }, REFINED_POLICY.debounceMs);
    },
    [runRefined],
  );

  const evaluateProvisional = useCallback(() => {
    const pipeline = pipelineRef.current;
    const utterance = pipeline.partial;
    if (utterance.trim().length === 0) return;

    const decision = decideProvisional({
      utterance,
      lastRequestedText: pipeline.lastRequestedText,
      lastRequestedAt: pipeline.lastRequestedAt,
      now: Date.now(),
      inFlight: pipeline.inFlight !== null,
      requestsThisUtterance: pipeline.requestsThisUtterance,
      // Max-wait safeguard (prompt 2 §3): a speaker who never pauses still gets
      // a suggestion, because the utterance age is now part of the decision.
      ...(pipeline.speechAt === null ? {} : { utteranceStartedAt: pipeline.speechAt }),
      ...(configRef.current === null
        ? {}
        : { maxWaitMs: configRef.current.provisionalMaxWaitMs }),
    });
    if (decision.action === 'skip') return;
    if (decision.cancelInFlight) pipeline.inFlight?.controller.abort();

    pipeline.lastRequestedText = utterance;
    pipeline.lastRequestedAt = Date.now();
    pipeline.requestsThisUtterance += 1;
    void requestReply('provisional', utterance);
  }, [requestReply]);

  const handleEvent = useCallback(
    (event: TranscriptionEvent) => {
      const pipeline = pipelineRef.current;

      if (event.type === 'speech-start') {
        if (pipeline.partial.length === 0) {
          pipeline.speechAt = event.at;
          pipeline.transcriptAt = null;
          pipeline.requestAt = null;
          pipeline.replyAt = null;
          pipeline.lastRequestedText = '';
          pipeline.requestsThisUtterance = 0;
        }
        return;
      }

      if (event.type === 'partial') {
        const text = event.text.slice(0, MAX_PARTIAL_BUFFER);
        pipeline.partial = text;
        if (pipeline.speechAt === null) pipeline.speechAt = event.at;
        if (pipeline.transcriptAt === null) pipeline.transcriptAt = event.at;
        setPartial(text);
        evaluateProvisional();
        return;
      }

      if (event.type === 'final') {
        updateSegments([
          ...segmentsRef.current,
          {
            id: makeId(),
            text: event.text,
            final: true,
            startedAt: pipeline.speechAt ?? event.at,
            endedAt: event.at,
          },
        ]);
        pipeline.partial = '';
        pipeline.lastRequestedText = '';
        pipeline.requestsThisUtterance = 0;
        setPartial('');
        scheduleRefined(event.text);
        return;
      }

      if (event.type === 'speech-end') {
        // VAD boundary. If the final transcript has not arrived yet, refine on
        // the current partial: a slightly rougher reply that arrives sooner is
        // worth more on a live call.
        if (pipeline.partial.trim().length > 0) scheduleRefined(pipeline.partial);
        return;
      }

      if (event.type === 'context-uncertain') {
        setContextUncertain(true);
        return;
      }

      if (event.type === 'status') {
        setStatus(event.status);
        setStatusDetail(event.detail ?? null);
        if (event.status === 'listening') setError(null);
        return;
      }

      setError(event.error);
      if (!event.error.retryable) setStatus('error');
    },
    [evaluateProvisional, scheduleRefined, updateSegments],
  );

  const stopInternal = useCallback(
    (finalStatus: SessionStatus) => {
      const pipeline = pipelineRef.current;
      if (pipeline.refinedTimer !== null) {
        clearTimeout(pipeline.refinedTimer);
        pipeline.refinedTimer = null;
      }
      pipeline.inFlight?.controller.abort();
      pipeline.inFlight = null;
      setReplyPending(false);

      providerRef.current?.stop();
      providerRef.current = null;
      stopMonitor();
      captureRef.current?.stop();
      captureRef.current = null;

      const sessionId = pipeline.sessionId;
      pipeline.sessionId = null;
      if (sessionId !== null) void api.deleteSession(sessionId).catch(() => undefined);

      setActiveProviderLabel(null);
      setStatus(finalStatus);
    },
    [api, stopMonitor],
  );

  const start = useCallback(async () => {
    if (startingRef.current) return;
    if (status === 'listening' || status === 'connecting' || status === 'reconnecting') return;

    startingRef.current = true;
    setError(null);
    setRequestError(null);
    setStatusDetail(null);
    setContextUncertain(false);
    setStatus('requesting-permission');

    const activeSettings = settingsRef.current;
    const provider = createProvider(activeSettings.provider);
    let sessionId: string | null = null;

    try {
      // Server session first: if the backend is unreachable we say so before
      // the user goes hunting for the right tab in the share picker.
      const session = await api.createSession();
      sessionId = session.id;

      let capture: AudioCapture | null = null;
      if (provider.consumesCapturedStream) {
        if (activeSettings.captureMode === 'tab' || activeSettings.captureMode === 'system') {
          if (!isTabAudioSupported()) throw captureError('NO_DISPLAY_MEDIA');
          capture =
            activeSettings.captureMode === 'system' ? await captureSystemAudio() : await captureTabAudio();
        } else {
          capture = await captureMicrophone();
        }

        // Never claim "connected" on a silent stream.
        const check = await verifyAudioIsUsable(capture.stream);
        if (!check.ok) {
          capture.stop();
          throw captureError('SILENT_AUDIO', {
            hint:
              capture.kind === 'system'
                ? 'No sound reached the browser from the system. Confirm the call is playing on this device, and that you ticked "Share system audio" in the picker.'
                : capture.kind === 'tab'
                  ? 'No sound came from the shared tab. Re-share it and tick "Also share tab audio".'
                  : 'The microphone is open but silent. Check it is not muted and the right device is selected.',
          });
        }
        captureRef.current = capture;

        monitorRef.current?.stop();
        const monitor = new AudioLevelMonitor(setLevel);
        monitor.start(capture.stream);
        monitorRef.current = monitor;
      } else if (activeSettings.provider === 'browser-speech' && !isBrowserSpeechSupported()) {
        throw captureError('UNSUPPORTED_BROWSER');
      }

      pipelineRef.current = { ...emptyPipeline(), sessionId };
      sequencerRef.current = createSequencer();
      setStatus('connecting');

      providerRef.current = provider;
      setActiveProviderLabel(provider.label);
      await provider.start({
        stream: capture?.stream ?? null,
        emit: handleEvent,
        signal: new AbortController().signal,
        getRealtimeToken: tokenSource(api),
        ...(sessionId === null ? {} : { transcribeChunk: chunkSource(api, sessionId) }),
      });
    } catch (err) {
      setError(describeCaptureFailure(err));
      setStatus('error');
      providerRef.current?.stop();
      providerRef.current = null;
      captureRef.current?.stop();
      captureRef.current = null;
      stopMonitor();
      pipelineRef.current.sessionId = null;
      if (sessionId !== null) void api.deleteSession(sessionId).catch(() => undefined);
    } finally {
      startingRef.current = false;
    }
  }, [api, handleEvent, status, stopMonitor]);

  const stop = useCallback(() => {
    stopInternal('stopped');
    setStatusDetail(null);
  }, [stopInternal]);

  const pause = useCallback(() => {
    if (status !== 'listening' && status !== 'connecting' && status !== 'reconnecting') return;
    const pipeline = pipelineRef.current;
    if (pipeline.refinedTimer !== null) {
      clearTimeout(pipeline.refinedTimer);
      pipeline.refinedTimer = null;
    }
    pipeline.inFlight?.controller.abort();
    pipeline.inFlight = null;
    providerRef.current?.stop();
    providerRef.current = null;
    setReplyPending(false);
    setStatus('paused');
    setStatusDetail('Transcription is paused. Audio permission is still held.');
  }, [status]);

  const resume = useCallback(async () => {
    if (status !== 'paused') return;
    if (pipelineRef.current.sessionId === null) {
      await start();
      return;
    }

    const provider = createProvider(settingsRef.current.provider);
    setStatus('connecting');
    providerRef.current = provider;
    setActiveProviderLabel(provider.label);
    const sessionId = pipelineRef.current.sessionId;
    try {
      await provider.start({
        stream: captureRef.current?.stream ?? null,
        emit: handleEvent,
        signal: new AbortController().signal,
        getRealtimeToken: tokenSource(api),
        ...(sessionId === null ? {} : { transcribeChunk: chunkSource(api, sessionId) }),
      });
    } catch (err) {
      setError(describeCaptureFailure(err));
      setStatus('error');
    }
  }, [api, handleEvent, start, status]);

  const regenerate = useCallback(async () => {
    const pipeline = pipelineRef.current;
    const utterance =
      pipeline.partial.trim().length > 0
        ? pipeline.partial
        : (lastFinalSegments(segmentsRef.current, 1)[0] ?? '');
    if (utterance.trim().length === 0) return;
    if (pipeline.sessionId === null) {
      setRequestError({
        code: 'SESSION_NOT_FOUND',
        message: 'Start live assistance before requesting a reply.',
      });
      return;
    }
    pipeline.lastRefinedFor = '';
    await requestReply('refined', utterance, true);
  }, [requestReply]);

  /**
   * Rewrite the script on screen.
   *
   * Deliberately not allowed to invent a new answer: the utterance is the one
   * the current reply was generated from (`forUtterance`), and the server is
   * told to rewrite the previous text rather than re-answer the transcript.
   */
  const refine = useCallback(
    async (directive: RefineDirective) => {
      const current = replyRef.current;
      if (current === null) return;
      if (pipelineRef.current.sessionId === null) {
        setRequestError({
          code: 'SESSION_NOT_FOUND',
          message: 'Start live assistance before refining a reply.',
        });
        return;
      }
      await requestReply('refined', current.forUtterance, true, {
        refine: directive,
        previousReply: current.suggestedReply,
      });
    },
    [requestReply],
  );

  /**
   * Re-answer in a new tone.
   *
   * A genuine re-request, not a client-side rewrite: tone changes what the model
   * is asked for, so pretending it could be applied locally would be theatre.
   * Falls back to the last finalised utterance so choosing a tone before any
   * reply exists still takes effect on the next one.
   */
  const applyTone = useCallback(
    async (tone: ReplyTone) => {
      const current = replyRef.current;
      const utterance =
        current?.forUtterance ?? lastFinalSegments(segmentsRef.current, 1)[0] ?? '';
      if (utterance.trim().length === 0) return;
      if (pipelineRef.current.sessionId === null) return;
      await requestReply('refined', utterance, true, { tone });
    },
    [requestReply],
  );

  const clearTranscript = useCallback(() => {
    updateSegments([]);
    pipelineRef.current.lastRefinedFor = '';
    pipelineRef.current.partial = '';
    setPartial('');
    setReply(null);
    setDiscardedStale(0);
    setContextUncertain(false);
  }, [updateSegments]);

  useEffect(() => {
    return () => {
      providerRef.current?.stop();
      monitorRef.current?.stop();
      captureRef.current?.stop();
      pipelineRef.current.inFlight?.controller.abort();
    };
  }, []);

  const isActive = useMemo(
    () => ['listening', 'connecting', 'reconnecting', 'paused', 'requesting-permission'].includes(status),
    [status],
  );

  /**
   * What the pipeline is doing, in the words prompt 2 §6 requires.
   *
   * Derived rather than stored so it can never contradict `status`,
   * `replyPending` or the partial transcript.
   */
  const pipelineStage = useMemo<PipelineStage>(() => {
    if (status === 'error') return 'unavailable';
    if (status === 'requesting-permission' || status === 'connecting' || status === 'reconnecting') {
      return 'connecting';
    }
    if (status !== 'listening' && status !== 'paused') return 'idle';
    if (replyPending) return reply === null ? 'generating' : 'refining';
    if (partial.trim().length > 0) return 'transcribing';
    return 'listening';
  }, [status, replyPending, partial, reply]);

  return {
    config,
    configError,
    configNotice,
    dismissConfigNotice: useCallback(() => setConfigNotice(null), []),
    status,
    statusDetail,
    error,
    requestError,
    contextUncertain,
    pipelineStage,
    segments,
    partial,
    reply,
    replyPending,
    discardedStale,
    latency,
    level,
    activeProviderLabel,
    isActive,
    start,
    stop,
    pause,
    resume,
    regenerate,
    refine,
    applyTone,
    clearTranscript,
  };
}

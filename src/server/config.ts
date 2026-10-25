import type { AppConfig } from '../shared/types';
import { isWhisperCppAvailable } from './services/whisperCpp';

/**
 * Environment configuration.
 *
 * Secrets are read here and nowhere else. `deriveConfig` is pure (env in,
 * config out) so tests can build an app with an explicit configuration instead
 * of mutating `process.env`.
 */

export type AiProviderId = 'openai' | 'groq' | 'openai-compatible' | 'local';
export type AiJsonMode = 'json_schema' | 'json_object';

/**
 * Speech-to-text providers.
 *
 * `openai-realtime` is true streaming over WebRTC: words appear while the
 * speaker is still talking. It is an OpenAI-only surface and therefore needs a
 * paid key.
 *
 * `openai-compatible` posts short WAV chunks to the ordinary
 * `/audio/transcriptions` endpoint, which free-tier hosts such as Groq offer.
 * It is deliberately NOT called streaming: the recognised text arrives only
 * after each chunk closes. See docs/STT_PROVIDERS.md.
 */
export type SttProviderId = 'openai-realtime' | 'openai-compatible' | 'whisper-cpp';
export type SttMode = 'realtime' | 'chunked';
/** Local recogniser transport: one process per chunk, or a resident server. */
export type WhisperMode = 'cli' | 'server';

export const STT_PROVIDER_PRESETS: Record<
  SttProviderId,
  { baseUrl: string; model: string; mode: SttMode }
> = {
  'openai-realtime': {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-transcribe',
    mode: 'realtime',
  },
  'openai-compatible': {
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'whisper-large-v3-turbo',
    mode: 'chunked',
  },
  // Fully local, fully free: the operator's own machine runs an MIT-licensed
  // Whisper model. No account, no key, no quota, no audio leaving the device.
  'whisper-cpp': {
    baseUrl: '',
    model: '.local-models/ggml-base.en.bin',
    mode: 'chunked',
  },
};

/**
 * Provider presets.
 *
 * All three speak the OpenAI chat-completions wire format, which is why one
 * client covers them. The difference that matters is `jsonMode`: `json_schema`
 * (strict, provider-enforced) is an OpenAI capability, while free-tier hosts
 * such as Groq expect `json_object` and are asked for the shape in the prompt.
 */
export const AI_PROVIDER_PRESETS: Record<
  AiProviderId,
  { baseUrl: string; model: string; jsonMode: AiJsonMode }
> = {
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    jsonMode: 'json_schema',
  },
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    jsonMode: 'json_object',
  },
  'openai-compatible': {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    jsonMode: 'json_object',
  },
  local: {
    // Ollama's OpenAI-compatible endpoint, bound to loopback.
    // Opt-in only: this is the developer's own machine, not the end-user path.
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:7b-instruct',
    jsonMode: 'json_object',
  },
};

export interface ServerConfig {
  appVersion: string;
  nodeEnv: 'development' | 'production' | 'test';
  port: number;

  corsOrigins: string[];

  /** Reply/translation provider. Free tiers use the openai-compatible wire format. */
  aiProvider: AiProviderId;
  /** Chat key for the chosen provider. Server-only; never reaches the browser. */
  aiApiKey: string | null;
  aiBaseUrl: string;
  aiModel: string;
  aiJsonMode: AiJsonMode;
  /** Hard cap on paid-or-free AI calls per server day. 0 disables the cap. */
  aiDailyRequestBudget: number;

  /** Streaming transcription is an OpenAI Realtime surface, so it uses its own key. */
  realtimeApiKey: string | null;
  transcribeModel: string;
  transcribeLanguage: string;
  realtimeSilenceMs: number;
  realtimeTokenTtlSeconds: number;

  /** Which speech-to-text transport is configured, and its credentials. */
  sttProvider: SttProviderId;
  sttMode: SttMode;
  sttApiKey: string | null;
  sttBaseUrl: string;
  sttModel: string;
  /** Target length of one chunked-STT request. */
  sttChunkMs: number;
  /** Trailing quiet that closes a chunk early, so text lands sooner. */
  sttSilenceMs: number;
  /** Chunked requests allowed per call session. Hard stop on a runaway loop. */
  sttMaxRequestsPerSession: number;
  /** whisper.cpp executable path (only used when sttProvider is whisper-cpp). */
  whisperBin: string;
  /** whisper.cpp ggml model path. */
  whisperModel: string;
  /**
   * How the local recogniser is driven: `cli` spawns one process per chunk,
   * `server` talks to an already-running whisper-server that holds the model in
   * memory. Server mode removes per-chunk process startup; see docs/LOCAL_STT.md.
   */
  whisperMode: WhisperMode;
  /** Base URL of the whisper-server, read only in server mode. */
  whisperServerUrl: string;
  /** whisper-server executable, used to check the local install is present. */
  whisperServerBin: string;

  maxTranscriptChars: number;
  contextWindowTurns: number;
  sessionTtlMinutes: number;
  aiRequestTimeoutMs: number;

  accessToken: string | null;
  rateLimitWindowMs: number;
  rateLimitMax: number;
  aiRateLimitMax: number;

  mockAi: boolean;

  /**
   * Use the local response library for provisional replies.
   *
   * On by default because it costs nothing: a template beats a paid request for
   * a partial sentence, which is the most frequently repeated case in the app.
   * Set AI_FAST_PATH=0 to force every reply through the model.
   */
  fastPathEnabled: boolean;
  /**
   * Milliseconds after the utterance began at which a provisional reply must be
   * produced even if the speaker has not paused. Without this a talker who never
   * pauses produces no suggestion at all.
   */
  provisionalMaxWaitMs: number;

  vocabPersistence: boolean;
  vocabFile: string;
}

function readString(env: NodeJS.ProcessEnv, key: string, fallback = ''): string {
  const raw = env[key];
  return raw === undefined ? fallback : raw.trim();
}

function readInt(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = readString(env, key);
  if (raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function readBool(env: NodeJS.ProcessEnv, key: string, fallback = false): boolean {
  const raw = readString(env, key).toLowerCase();
  if (raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function readList(env: NodeJS.ProcessEnv, key: string, fallback: string[] = []): string[] {
  const raw = readString(env, key);
  if (raw === '') return fallback;
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function deriveConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const nodeEnvRaw = readString(env, 'NODE_ENV', 'development');
  const nodeEnv: ServerConfig['nodeEnv'] =
    nodeEnvRaw === 'production' ? 'production' : nodeEnvRaw === 'test' ? 'test' : 'development';

  const openaiKey = readString(env, 'OPENAI_API_KEY');
  const explicitAiKey = readString(env, 'AI_API_KEY');
  const accessToken = readString(env, 'APP_ACCESS_TOKEN');

  const providerRaw = readString(env, 'AI_PROVIDER', 'openai').toLowerCase();
  const aiProvider: AiProviderId =
    providerRaw === 'openai' || providerRaw === 'groq' || providerRaw === 'local'
      ? providerRaw
      : 'openai-compatible';
  const preset = AI_PROVIDER_PRESETS[aiProvider];

  const aiKey = explicitAiKey !== '' ? explicitAiKey : openaiKey;
  const aiBaseUrl = (readString(env, 'AI_BASE_URL') ||
    readString(env, 'OPENAI_BASE_URL') ||
    preset.baseUrl
  ).replace(/\/+$/, '');
  const aiModel =
    readString(env, 'AI_MODEL') || readString(env, 'OPENAI_REPLY_MODEL') || preset.model;
  const jsonModeRaw = readString(env, 'AI_JSON_MODE').toLowerCase();
  const aiJsonMode: AiJsonMode =
    jsonModeRaw === 'json_schema' || jsonModeRaw === 'json_object' ? jsonModeRaw : preset.jsonMode;

  // Realtime transcription only exists on the OpenAI surface. A key aimed at a
  // different provider must never be presented as a working streaming path.
  const realtimeApiKey = aiProvider === 'openai' && openaiKey !== '' ? openaiKey : null;

  // Speech-to-text is configured independently of the reply provider: a free
  // Groq key can drive transcription while replies stay on any chat model.
  const sttProviderRaw = readString(env, 'STT_PROVIDER').toLowerCase();
  const sttProvider: SttProviderId =
    sttProviderRaw === 'openai-compatible'
      ? 'openai-compatible'
      : sttProviderRaw === 'whisper-cpp'
        ? 'whisper-cpp'
        : 'openai-realtime';
  const sttPreset = STT_PROVIDER_PRESETS[sttProvider];
  const explicitSttKey = readString(env, 'STT_API_KEY') || readString(env, 'GROQ_API_KEY');
  // A local recogniser needs no credential at all, so it must never be gated on
  // one - that is exactly the bug that made a working local setup look broken.
  const sttKey =
    sttProvider === 'whisper-cpp'
      ? ''
      : explicitSttKey !== ''
        ? explicitSttKey
        : sttProvider === 'openai-realtime'
          ? openaiKey
          : '';
  const sttBaseUrl = (readString(env, 'STT_BASE_URL') || sttPreset.baseUrl).replace(/\/+$/, '');
  const sttModel = readString(env, 'STT_MODEL') || sttPreset.model;

  return {
    appVersion: readString(env, 'APP_VERSION', '1.0.0'),
    nodeEnv,
    port: readInt(env, 'PORT', 8787, 1, 65535),

    corsOrigins: readList(env, 'CORS_ORIGINS', ['http://localhost:5173', 'http://127.0.0.1:5173']),

    aiProvider,
    aiApiKey: aiKey === '' ? null : aiKey,
    aiBaseUrl,
    aiModel,
    aiJsonMode,
    aiDailyRequestBudget: readInt(env, 'AI_DAILY_REQUEST_BUDGET', 200, 0, 100000),
    realtimeApiKey,
    transcribeModel: readString(env, 'OPENAI_TRANSCRIBE_MODEL', sttPreset.model),
    transcribeLanguage: readString(env, 'OPENAI_TRANSCRIBE_LANGUAGE', 'en'),
    realtimeSilenceMs: readInt(env, 'REALTIME_SILENCE_MS', 320, 100, 3000),
    realtimeTokenTtlSeconds: readInt(env, 'REALTIME_TOKEN_TTL_SECONDS', 600, 60, 3600),

    sttProvider,
    sttMode: sttPreset.mode,
    sttApiKey: sttKey === '' ? null : sttKey,
    sttBaseUrl,
    sttModel,
    sttChunkMs: readInt(env, 'STT_CHUNK_MS', 2400, 800, 10000),
    sttSilenceMs: readInt(env, 'STT_SILENCE_MS', 420, 120, 2000),
    sttMaxRequestsPerSession: readInt(env, 'STT_MAX_REQUESTS_PER_SESSION', 240, 1, 100000),
    whisperBin:
      readString(env, 'WHISPER_CPP_BIN') || '.local-models/Release/whisper-cli.exe',
    whisperModel: readString(env, 'WHISPER_CPP_MODEL') || sttPreset.model,
    whisperMode: readString(env, 'WHISPER_CPP_MODE').toLowerCase() === 'server' ? 'server' : 'cli',
    whisperServerUrl:
      (readString(env, 'WHISPER_CPP_SERVER_URL') || 'http://127.0.0.1:8080').replace(/\/+$/, ''),
    whisperServerBin:
      readString(env, 'WHISPER_CPP_SERVER_BIN') || '.local-models/Release/whisper-server.exe',

    maxTranscriptChars: readInt(env, 'MAX_TRANSCRIPT_CHARS', 4000, 200, 8000),
    contextWindowTurns: readInt(env, 'CONTEXT_WINDOW_TURNS', 6, 1, 12),
    sessionTtlMinutes: readInt(env, 'SESSION_TTL_MINUTES', 120, 5, 1440),
    aiRequestTimeoutMs: readInt(env, 'AI_REQUEST_TIMEOUT_MS', 20000, 2000, 60000),

    accessToken: accessToken === '' ? null : accessToken,
    rateLimitWindowMs: readInt(env, 'RATE_LIMIT_WINDOW_MS', 60000, 1000, 600000),
    rateLimitMax: readInt(env, 'RATE_LIMIT_MAX', 120, 1, 100000),
    aiRateLimitMax: readInt(env, 'AI_RATE_LIMIT_MAX', 40, 1, 100000),

    mockAi: readBool(env, 'MOCK_AI', false),

    fastPathEnabled: readBool(env, 'AI_FAST_PATH', true),
    provisionalMaxWaitMs: readInt(env, 'PROVISIONAL_MAX_WAIT_MS', 1800, 300, 15000),

    vocabPersistence: readBool(env, 'ENABLE_VOCAB_PERSISTENCE', false),
    vocabFile: readString(env, 'VOCAB_FILE', '.data/vocabulary.json'),
  };
}

/** True when the server can call a real model (real key, or the forced mock). */
export function isAiConfigured(config: ServerConfig): boolean {
  // A local model server needs no credential, so the key cannot be the test.
  return config.mockAi || config.aiApiKey !== null || config.aiProvider === 'local';
}

/**
 * True when real streaming transcription is possible.
 * A mock AI does NOT imply a mock realtime transport: the simulated transcript
 * provider runs entirely in the browser and is labelled as a simulation.
 */
export function isRealtimeConfigured(config: ServerConfig): boolean {
  return config.realtimeApiKey !== null;
}

/**
 * True when SOME real transcription route is usable.
 *
 * Kept separate from `isRealtimeConfigured` so the UI can say "chunked" instead
 * of claiming live streaming that the configuration cannot deliver.
 */
export function isSttConfigured(config: ServerConfig): boolean {
  if (config.sttProvider === 'whisper-cpp') {
    // Local: present on disk is the only meaningful test, and no key applies.
    // In server mode the CLI is irrelevant, so check the server binary instead.
    if (config.whisperMode === 'server') {
      return isWhisperCppAvailable(config.whisperServerBin, config.whisperModel);
    }
    return isWhisperCppAvailable(config.whisperBin, config.whisperModel);
  }
  return config.sttApiKey !== null;
}

/** The subset of configuration that is safe to hand to the browser. */
export function toPublicAppConfig(config: ServerConfig): AppConfig {
  return {
    version: config.appVersion,
    environment: config.nodeEnv,
    aiConfigured: isAiConfigured(config),
    mockAi: config.mockAi,
    realtimeConfigured: isRealtimeConfigured(config),
    sttConfigured: isSttConfigured(config),
    sttProvider: config.sttProvider,
    sttMode: config.sttMode,
    sttModel: config.sttModel,
    authRequired: config.accessToken !== null,
    replyProvider: config.aiProvider,
    replyModel: config.aiModel,
    aiJsonMode: config.aiJsonMode,
    aiDailyRequestBudget: config.aiDailyRequestBudget,
    fastPathEnabled: config.fastPathEnabled,
    provisionalMaxWaitMs: config.provisionalMaxWaitMs,
    transcribeModel: config.transcribeModel,
    transcribeLanguage: config.transcribeLanguage,
    maxTranscriptChars: config.maxTranscriptChars,
    contextWindowTurns: config.contextWindowTurns,
    sessionTtlMinutes: config.sessionTtlMinutes,
    features: {
      vocabulary: true,
      vocabularyPersistence: config.vocabPersistence,
    },
  };
}

import type { ServerConfig } from '../config';
import { isAiConfigured, isSttConfigured } from '../config';
import { CircuitBreaker } from './breaker';
import { AiRequestBudget, type BudgetState } from './budget';
import { MockAiClient, OpenAiClient, UnconfiguredAiClient, type AiClient } from './openai';
import { SessionStore } from './sessions';
import { createSttClient, type SttClient } from './stt';
import {
  WhisperCppSttClient,
  UnconfiguredWhisperCppSttClient,
  isWhisperCppAvailable,
} from './whisperCpp';
import { WhisperServerSttClient } from './whisperServer';
import { createReplyLiveness, type ReplyLiveness } from './replyLiveness';
import { VocabularyStore } from './vocabulary';

/**
 * Composition root for the backend services. Routes receive this object
 * instead of reaching for module-level singletons, which is what makes
 * `createApp({ services })` usable in tests with a mock AI client.
 */
export interface Services {
  config: ServerConfig;
  ai: AiClient;
  stt: SttClient;
  breaker: CircuitBreaker;
  budget: AiRequestBudget;
  sessions: SessionStore;
  vocabulary: VocabularyStore;
  /** Probes whether a local reply model is actually running. See replyLiveness.ts. */
  replyLiveness: ReplyLiveness;
}

export interface ServiceOverrides {
  aiClient?: AiClient;
  sttClient?: SttClient;
  /** Injected so tests can assert the provider request without a network. */
  sttFetch?: typeof fetch;
  /** Injected so /api/health liveness probes never reach the network in tests. */
  livenessFetch?: typeof fetch;
  now?: () => number;
}

function buildSttClient(config: ServerConfig, overrides: ServiceOverrides): SttClient {
  if (overrides.sttClient !== undefined) return overrides.sttClient;

  // A local recogniser is chosen explicitly and never falls back to a hosted
  // service: silently switching provider would break the ₹0 promise.
  if (config.sttProvider === 'whisper-cpp') {
    if (config.whisperMode === 'server') {
      if (!isWhisperCppAvailable(config.whisperServerBin, config.whisperModel)) {
        return new UnconfiguredWhisperCppSttClient(
          `Local transcription in server mode needs whisper-server. Expected ${config.whisperServerBin} and ${config.whisperModel}. ` +
            'See docs/LOCAL_STT.md, or set WHISPER_CPP_MODE=cli to spawn whisper-cli per chunk.',
        );
      }
      return new WhisperServerSttClient({
        serverUrl: config.whisperServerUrl,
        timeoutMs: config.aiRequestTimeoutMs,
        language: config.transcribeLanguage,
        modelName: config.whisperModel.split(/[\\/]/).pop() ?? config.whisperModel,
        ...(overrides.sttFetch === undefined ? {} : { fetchImpl: overrides.sttFetch }),
      });
    }
    if (!isWhisperCppAvailable(config.whisperBin, config.whisperModel)) {
      return new UnconfiguredWhisperCppSttClient(
        `Local transcription needs whisper.cpp. Expected ${config.whisperBin} and ${config.whisperModel}. ` +
          'See docs/LOCAL_STT.md to download them, or set WHISPER_CPP_BIN / WHISPER_CPP_MODEL.',
      );
    }
    return new WhisperCppSttClient({
      binaryPath: config.whisperBin,
      modelPath: config.whisperModel,
      timeoutMs: config.aiRequestTimeoutMs,
      language: config.transcribeLanguage,
    });
  }

  return createSttClient(config, overrides.sttFetch === undefined ? {} : { fetchImpl: overrides.sttFetch });
}

export function createServices(config: ServerConfig, overrides: ServiceOverrides = {}): Services {
  const now = overrides.now ?? (() => Date.now());

  const ai: AiClient =
    overrides.aiClient ??
    (config.mockAi
      ? new MockAiClient()
      : isAiConfigured(config)
        ? new OpenAiClient({
            id: config.aiProvider,
            // A local model server legitimately has no key.
            apiKey: config.aiApiKey ?? '',
            baseUrl: config.aiBaseUrl,
            timeoutMs: config.aiRequestTimeoutMs,
            jsonMode: config.aiJsonMode,
          })
        : new UnconfiguredAiClient());

  return {
    config,
    ai,
    stt: buildSttClient(config, overrides),
    breaker: new CircuitBreaker({ threshold: 3, cooldownMs: 20_000, now }),
    budget: new AiRequestBudget({ limit: config.aiDailyRequestBudget, now }),
    sessions: new SessionStore({ ttlMinutes: config.sessionTtlMinutes, now }),
    vocabulary: new VocabularyStore({
      persist: config.vocabPersistence,
      filePath: config.vocabFile,
    }),
    replyLiveness: createReplyLiveness(config, {
      now,
      ...(overrides.livenessFetch === undefined ? {} : { fetchImpl: overrides.livenessFetch }),
    }),
  };
}

/** Reported by /api/health and /api/config. */
export function providerStatus(services: Services): {
  aiConfigured: boolean;
  mockAi: boolean;
  provider: string;
  stt: { provider: string; mode: string; configured: boolean; model: string };
  breaker: { open: boolean; consecutiveFailures: number };
  budget: BudgetState;
} {
  const breaker = services.breaker.state();
  return {
    aiConfigured: isAiConfigured(services.config),
    mockAi: services.config.mockAi,
    provider: services.ai.id,
    stt: {
      provider: services.stt.id,
      mode: services.stt.mode,
      // Must not be "holds a secret": a local recogniser is configured by having
      // its files on disk, and has no key at all. Testing for a key here made a
      // perfectly working local setup report itself broken.
      configured: isSttConfigured(services.config),
      model: services.stt.model,
    },
    breaker: { open: breaker.open, consecutiveFailures: breaker.consecutiveFailures },
    budget: services.budget.state(),
  };
}

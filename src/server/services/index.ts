import type { ServerConfig } from '../config';
import { isAiConfigured, isSttConfigured } from '../config';
import { CircuitBreaker } from './breaker';
import { MemoryAiRequestBudget, type AiBudget, type BudgetState } from './budget';
import { PostgresAiBudget } from './budgetStorePostgres';
import { MockAiClient, OpenAiClient, UnconfiguredAiClient, type AiClient } from './openai';
import { MemorySessionStore, type SessionStore } from './sessions';
import { PostgresSessionStore, createPgPool, type Queryable } from './sessionStorePostgres';
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
  budget: AiBudget;
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
  /** Injected so the Postgres path is testable without a database. */
  sessionStore?: SessionStore;
  /** Injected so a test can drive the daily cap without spending real requests. */
  budget?: AiBudget;
  dbQueryable?: Queryable;
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

/**
 * One database pool for every store that needs one.
 *
 * A serverless host caps connections per instance, so a second pool would halve
 * that limit for no benefit. `null` means "no database configured".
 */
function buildDatabase(config: ServerConfig, overrides: ServiceOverrides): Queryable | null {
  // DATABASE_URL is the switch, not the presence of a queryable: an injected
  // queryable only *supplies* the connection, it must not by itself turn a
  // memory-mode deployment into a Postgres one.
  if (config.databaseUrl === null) return null;
  if (overrides.dbQueryable !== undefined) return overrides.dbQueryable;
  return createPgPool({
    connectionString: config.databaseUrl,
    max: config.databasePoolMax,
    ssl: config.databaseSsl,
  });
}

/**
 * Chooses the session store.
 *
 * With no DATABASE_URL the process keeps sessions in memory, which is correct
 * for `npm run dev` and the test suite. With one, sessions live in Postgres,
 * which is the only way a multi-instance or serverless deployment can work: a
 * session created by one instance must be visible to the next.
 */
function buildSessionStore(
  config: ServerConfig,
  overrides: ServiceOverrides,
  database: Queryable | null,
): SessionStore {
  if (overrides.sessionStore !== undefined) return overrides.sessionStore;

  const now = overrides.now;
  const ttlMinutes = config.sessionTtlMinutes;

  if (database === null) {
    return new MemorySessionStore({ ttlMinutes, ...(now === undefined ? {} : { now }) });
  }

  return new PostgresSessionStore({
    ttlMinutes,
    queryable: database,
    ...(now === undefined ? {} : { now }),
  });
}

/**
 * Chooses the budget store by the same rule as the session store.
 *
 * Without a database the daily counter is per process, which is honest for
 * `npm run dev` and the test suite. With one, every instance shares a single
 * UTC-day counter - without it the cap is per *instance*, so two warm instances
 * allow twice the configured number and every cold start resets it.
 */
function buildBudget(
  config: ServerConfig,
  overrides: ServiceOverrides,
  database: Queryable | null,
): AiBudget {
  if (overrides.budget !== undefined) return overrides.budget;

  const now = overrides.now;
  const limit = config.aiDailyRequestBudget;
  const clock = now === undefined ? {} : { now };

  if (database === null) return new MemoryAiRequestBudget({ limit, ...clock });
  return new PostgresAiBudget({ limit, queryable: database, ...clock });
}

export function createServices(config: ServerConfig, overrides: ServiceOverrides = {}): Services {
  const now = overrides.now ?? (() => Date.now());
  const database = buildDatabase(config, overrides);

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
    budget: buildBudget(config, overrides, database),
    sessions: buildSessionStore(config, overrides, database),
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
export async function providerStatus(services: Services): Promise<{
  aiConfigured: boolean;
  mockAi: boolean;
  provider: string;
  stt: { provider: string; mode: string; configured: boolean; model: string };
  breaker: { open: boolean; consecutiveFailures: number };
  budget: BudgetState;
}> {
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
    // Awaited: with a shared store the count lives in the database, so there is
    // no synchronous answer to give.
    budget: await services.budget.state(),
  };
}

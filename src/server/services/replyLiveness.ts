import { logger } from '../lib/logger';
import type { ServerConfig } from '../config';

/**
 * Whether the configured reply model is actually *answering*, as opposed to
 * merely being selected.
 *
 * `deriveConfig()` is synchronous and must never touch the network, so
 * `isAiConfigured()` can only answer "is a provider chosen?". For a `local`
 * provider that is true the instant `AI_PROVIDER=local` is set — even with
 * nothing listening on loopback. The browser then reports AI as ready, and every
 * refined reply arrives as a labelled `safe_fallback`, which reads like a bad
 * model rather than a stopped one.
 *
 * This probe answers the second question, on demand, and only for a local
 * provider. A hosted provider's liveness is decided by its key at request time;
 * polling a third party from /health would be both slow and wrong.
 */
export interface ReplyModelState {
  provider: string;
  model: string;
  /** false for hosted providers: we do not probe third parties from /health. */
  applicable: boolean;
  /** null when not applicable, otherwise whether something answered. */
  reachable: boolean | null;
  /** Operator-facing reason. Empty when reachable. */
  detail: string;
  /** Epoch ms of the probe behind this state; 0 when never probed. */
  checkedAt: number;
}

export interface ReplyLiveness {
  /** Last known state. Never blocks, never triggers a probe. */
  state(): ReplyModelState;
  /** Probe if the cached answer is stale. Never throws. */
  check(): Promise<ReplyModelState>;
}

const DEFAULT_TTL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 800;

/** Node puts the syscall reason on `cause`; `ECONNREFUSED` is the common one. */
function describeError(error: unknown): string {
  const cause = (error as { cause?: { code?: string } } | null)?.cause;
  if (cause?.code !== undefined) return cause.code;
  if (error instanceof Error) return error.name;
  return 'unreachable';
}

export function createReplyLiveness(
  config: ServerConfig,
  options: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    ttlMs?: number;
    now?: () => number;
  } = {},
): ReplyLiveness {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? (() => Date.now());

  const applicable = config.aiProvider === 'local';

  const unprobed = (): ReplyModelState => ({
    provider: config.aiProvider,
    model: config.aiModel,
    applicable,
    reachable: null,
    detail: applicable
      ? 'Not probed yet.'
      : 'Reachability is decided by the provider key at request time, not by a local socket.',
    checkedAt: 0,
  });

  let cached = unprobed();
  let inFlight: Promise<ReplyModelState> | null = null;

  const probe = async (): Promise<ReplyModelState> => {
    if (!applicable) {
      cached = unprobed();
      return cached;
    }

    // Ollama and LM Studio both expose the OpenAI-compatible model list, so any
    // HTTP answer is proof the process is up. A 401 still means "listening".
    const url = `${config.aiBaseUrl.replace(/\/+$/, '')}/models`;
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        signal: AbortSignal.timeout(timeoutMs),
      });
      // Drain so the socket is not kept alive on a long-lived server process.
      await response.text().catch(() => '');
      cached = {
        provider: config.aiProvider,
        model: config.aiModel,
        applicable: true,
        reachable: true,
        detail: '',
        checkedAt: now(),
      };
    } catch (error) {
      const code = describeError(error);
      cached = {
        provider: config.aiProvider,
        model: config.aiModel,
        applicable: true,
        reachable: false,
        detail: `Nothing answered at ${config.aiBaseUrl} (${code}). Start the local model server - see docs/LOCAL_MODEL.md.`,
        checkedAt: now(),
      };
      logger.warn('reply.model_unreachable', { url, detail: code });
    }
    return cached;
  };

  return {
    state: () => cached,
    check: () => {
      if (!applicable) return Promise.resolve(unprobed());
      const fresh = cached.checkedAt !== 0 && now() - cached.checkedAt < ttlMs;
      if (fresh) return Promise.resolve(cached);
      // Coalesce concurrent polls: a UI refresh must not fan out into N probes.
      inFlight ??= probe().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}

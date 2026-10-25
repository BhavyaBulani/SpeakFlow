import { detectMaterialChange, hasMeaningfulContext, wordCount } from './transcript';
import type { ReplyResult } from './types';

/**
 * The two-stage reply pipeline policy, expressed as pure functions.
 *
 * This file is the heart of the product: it decides *when* we are allowed to
 * spend an AI request. Keeping it pure means the tricky parts (throttling,
 * staleness, cancellation) are unit tested without a network or a browser.
 */

export const PROVISIONAL_POLICY = {
  /** Below this, any reply would be a guess. */
  minWords: 4,
  /** Never fire provisional requests faster than this. */
  minIntervalMs: 1100,
  /** Hard cap per utterance so one long ramble cannot burn the budget. */
  maxRequestsPerUtterance: 5,
  /** If an in-flight request is younger than this, let it land instead of thrashing. */
  inFlightGraceMs: 900,
  /**
   * Maximum-wait safeguard.
   *
   * A speaker who never pauses and never ends a sentence would otherwise produce
   * no suggestion at all, because every release rule is waiting for a boundary
   * that never arrives. Once the utterance is this old, a material change is
   * enough to fire even if the debounce interval has not elapsed.
   */
  maxWaitMs: 1800,
} as const;

export const REFINED_POLICY = {
  minWords: 2,
  /** Small debounce so two rapid finals collapse into one refined request. */
  debounceMs: 220,
} as const;

export type ProvisionalSkipReason =
  | 'no-context'
  | 'unchanged'
  | 'throttled'
  | 'in-flight'
  | 'budget-exhausted';

export interface ProvisionalDecision {
  action: 'request' | 'skip';
  reason: ProvisionalSkipReason | 'ok';
  /** True when an older in-flight request must be aborted to make room. */
  cancelInFlight: boolean;
  /** `extended` / `rephrased` / `became-question` / `first` */
  changeReason: string;
  /** True when the decision was forced by the max-wait rule, not a boundary. */
  forcedByMaxWait: boolean;
}

export interface ProvisionalInput {
  utterance: string;
  /** Text the last provisional reply was generated from. */
  lastRequestedText: string;
  /** Timestamp (ms) when the last provisional request was fired, 0 if none. */
  lastRequestedAt: number;
  now: number;
  /** Is a provisional request still outstanding? */
  inFlight: boolean;
  /** How many provisional requests this utterance has already produced. */
  requestsThisUtterance: number;
  /**
   * Timestamp (ms) when the current utterance began (first speech/partial).
   * Omit to disable the max-wait rule.
   */
  utteranceStartedAt?: number;
  /** Override for tests and for wiring the configurable PROVISIONAL_MAX_WAIT_MS. */
  maxWaitMs?: number;
}

function skip(reason: ProvisionalSkipReason, changeReason: string): ProvisionalDecision {
  return { action: 'skip', reason, cancelInFlight: false, changeReason, forcedByMaxWait: false };
}

export function decideProvisional(input: ProvisionalInput): ProvisionalDecision {
  if (!hasMeaningfulContext(input.utterance, PROVISIONAL_POLICY.minWords)) {
    return skip('no-context', 'none');
  }

  const change = detectMaterialChange(input.lastRequestedText, input.utterance);

  if (input.requestsThisUtterance >= PROVISIONAL_POLICY.maxRequestsPerUtterance) {
    return skip('budget-exhausted', change.reason);
  }

  const maxWaitMs = input.maxWaitMs ?? PROVISIONAL_POLICY.maxWaitMs;
  const utteranceAgeMs =
    input.utteranceStartedAt === undefined ? 0 : Math.max(0, input.now - input.utteranceStartedAt);
  const pastMaxWait = utteranceAgeMs >= maxWaitMs;

  if (input.inFlight) {
    const age = input.now - input.lastRequestedAt;
    if (age < PROVISIONAL_POLICY.inFlightGraceMs) {
      return skip('in-flight', change.reason);
    }
    // Old request is stale: cancel it and take a fresh shot at the new text.
    return {
      action: 'request',
      reason: 'ok',
      cancelInFlight: true,
      changeReason: change.reason,
      forcedByMaxWait: false,
    };
  }

  const throttled =
    input.lastRequestedAt > 0 && input.now - input.lastRequestedAt < PROVISIONAL_POLICY.minIntervalMs;

  if (throttled) {
    // The max-wait rule deliberately bypasses only the *throttle*, and only when
    // the text materially changed: firing the same text again buys nothing.
    if (pastMaxWait && change.changed) {
      return {
        action: 'request',
        reason: 'ok',
        cancelInFlight: false,
        changeReason: change.reason,
        forcedByMaxWait: true,
      };
    }
    return skip('throttled', change.reason);
  }

  if (!change.changed) {
    return skip('unchanged', change.reason);
  }

  return {
    action: 'request',
    reason: 'ok',
    cancelInFlight: false,
    changeReason: change.reason,
    forcedByMaxWait: false,
  };
}

export interface RefinedDecision {
  action: 'request' | 'skip';
  reason: 'ok' | 'no-context' | 'unchanged';
  cancelInFlight: boolean;
}

export interface RefinedInput {
  /** The utterance that just finished. */
  utterance: string;
  /** Text the last refined reply was generated from, '' if none. */
  lastRefinedFor: string;
  inFlight: boolean;
}

export function decideRefined(input: RefinedInput): RefinedDecision {
  if (!hasMeaningfulContext(input.utterance, REFINED_POLICY.minWords)) {
    return { action: 'skip', reason: 'no-context', cancelInFlight: false };
  }
  if (input.lastRefinedFor !== '' && input.lastRefinedFor.trim() === input.utterance.trim()) {
    return { action: 'skip', reason: 'unchanged', cancelInFlight: false };
  }
  return { action: 'request', reason: 'ok', cancelInFlight: input.inFlight };
}

/**
 * Monotonic version gate. Every request gets a version; only the newest
 * version may write to the UI. This is what stops a slow provisional reply
 * from overwriting a newer refined one.
 */
export interface ReplySequencer {
  begin(): number;
  latest(): number;
  isLatest(version: number): boolean;
}

export function createSequencer(startAt = 0): ReplySequencer {
  let current = startAt;
  return {
    begin() {
      current += 1;
      return current;
    },
    latest() {
      return current;
    },
    isLatest(version) {
      return version === current;
    },
  };
}

export interface DisplayDecision {
  /** The reply that should now be on screen. */
  reply: ReplyResult | null;
  /** True when the incoming reply was discarded because it was outdated. */
  discardedStale: boolean;
}

/**
 * Accept-or-discard rule for incoming replies.
 *
 * A reply is displayed only if it is at least as new as what is on screen.
 * Equal versions are accepted (a late refinement of the same version), older
 * ones are dropped and counted so the UI can show "1 older reply discarded".
 */
export function pickReplyForDisplay(
  current: ReplyResult | null,
  incoming: ReplyResult,
): DisplayDecision {
  if (current === null) return { reply: incoming, discardedStale: false };
  if (incoming.version < current.version) return { reply: current, discardedStale: true };
  return { reply: incoming, discardedStale: false };
}

export interface LatencySummary {
  speechToTranscriptMs: number | null;
  transcriptToRequestMs: number | null;
  requestToReplyMs: number | null;
  speechToReplyMs: number | null;
}

/** Turn raw milestone timestamps into the numbers shown in the latency strip. */
export function summarizeLatency(marks: {
  speechAt?: number | null;
  transcriptAt?: number | null;
  requestAt?: number | null;
  replyAt?: number | null;
}): LatencySummary {
  const diff = (a?: number | null, b?: number | null): number | null =>
    a == null || b == null ? null : Math.max(0, Math.round(b - a));

  return {
    speechToTranscriptMs: diff(marks.speechAt, marks.transcriptAt),
    transcriptToRequestMs: diff(marks.transcriptAt, marks.requestAt),
    requestToReplyMs: diff(marks.requestAt, marks.replyAt),
    speechToReplyMs: diff(marks.speechAt, marks.replyAt),
  };
}

/** Short human hint shown while the AI is still thinking. */
export function holdingLine(utterance: string): string {
  return wordCount(utterance) < 6
    ? 'Sorry, could you say a little more about that?'
    : 'Let me make sure I understand you correctly.';
}

import { describe, expect, it } from 'vitest';
import {
  countNewWords,
  detectMaterialChange,
  hasMeaningfulContext,
  looksUnfinished,
  trimToChars,
  wordCount,
} from '../src/shared/transcript';
import {
  createSequencer,
  decideProvisional,
  decideRefined,
  pickReplyForDisplay,
  PROVISIONAL_POLICY,
  summarizeLatency,
} from '../src/shared/replyPipeline';
import type { ReplyResult } from '../src/shared/types';

/**
 * Acceptance criteria 5, 6, 7 and 8 live here: partial speech triggers a
 * provisional reply, a finished question triggers a refined one, stale replies
 * cannot win, and thin context is refused rather than guessed.
 */

function reply(overrides: Partial<ReplyResult>): ReplyResult {
  return {
    version: 1,
    stage: 'refined',
    suggestedReply: 'I will check and confirm.',
    alternativeReply: null,
    needsClarification: false,
    factsToVerify: [],
    confidence: 'medium',
    intent: 'question',
    engine: 'openai',
    model: 'test',
    latencyMs: 100,
    receivedAt: Date.now(),
    forUtterance: 'text',
    notice: null,
    ...overrides,
  };
}

describe('transcript helpers', () => {
  it('counts words and detects unfinished sentences', () => {
    expect(wordCount('Could you explain why the app is slow')).toBe(8);
    expect(looksUnfinished('Could you explain why the application is taking longer to')).toBe(true);
    expect(looksUnfinished('I will check the logs,')).toBe(true);
    expect(looksUnfinished('Yes, that works for me')).toBe(false);
    expect(looksUnfinished('um')).toBe(true);
  });

  it('refuses to call filler meaningful context', () => {
    expect(hasMeaningfulContext('uh huh okay', 4)).toBe(false);
    expect(hasMeaningfulContext('could you check the deployment today', 4)).toBe(true);
  });

  it('counts words that are new', () => {
    expect(countNewWords('the app is slow', 'the app is slow today again')).toBe(2);
  });

  it('detects a rephrase, an extension and a new question', () => {
    expect(detectMaterialChange('', 'anything').reason).toBe('first');
    // Nothing in common: a rephrase, not a continuation.
    expect(detectMaterialChange('the deployment failed', 'the login page is broken').reason).toBe('rephrased');
    // A pure superset with 4+ new words is an extension (the client is still talking).
    expect(detectMaterialChange('the app is slow', 'the app is slow today again after the deploy').reason).toBe(
      'extended',
    );
    // Two new words on a mostly-identical sentence is not enough to re-ask.
    expect(detectMaterialChange('the app is slow', 'the app is slow today again').changed).toBe(false);
    // A question mark appearing later changes the job from listening to answering.
    expect(detectMaterialChange('the app is slow today', 'the app is slow today?').reason).toBe(
      'became-question',
    );
    expect(detectMaterialChange('the app is slow today', 'the app is slow today').changed).toBe(false);
  });

  it('trims to a character budget keeping the newest words', () => {
    const trimmed = trimToChars('alpha beta gamma delta epsilon', 12);
    // Keeps the newest words, drops the old ones, never exceeds the budget.
    expect(trimmed.endsWith('epsilon')).toBe(true);
    expect(trimmed.includes('alpha')).toBe(false);
    expect(trimmed.length).toBeLessThanOrEqual(12);
    expect(trimToChars('short text', 100)).toBe('short text');
  });
});

describe('provisional policy', () => {
  it('skips thin context entirely', () => {
    const decision = decideProvisional({
      utterance: 'so',
      lastRequestedText: '',
      lastRequestedAt: 0,
      now: 1000,
      inFlight: false,
      requestsThisUtterance: 0,
    });
    expect(decision.action).toBe('skip');
    expect(decision.reason).toBe('no-context');
  });

  it('fires once meaningful context exists (criterion 5)', () => {
    const decision = decideProvisional({
      utterance: 'could you explain why the application is taking longer to',
      lastRequestedText: '',
      lastRequestedAt: 0,
      now: 1000,
      inFlight: false,
      requestsThisUtterance: 0,
    });
    expect(decision.action).toBe('request');
    expect(decision.changeReason).toBe('first');
  });

  it('does not re-request for unchanged text', () => {
    const decision = decideProvisional({
      utterance: 'could you explain why the application is taking longer to',
      lastRequestedText: 'could you explain why the application is taking longer to',
      lastRequestedAt: 1000,
      now: 5000,
      inFlight: false,
      requestsThisUtterance: 1,
    });
    expect(decision.action).toBe('skip');
    expect(decision.reason).toBe('unchanged');
  });

  it('throttles rapid changes inside the interval', () => {
    const decision = decideProvisional({
      utterance: 'could you explain why the application is taking much longer to load today',
      lastRequestedText: 'could you explain',
      lastRequestedAt: 1000,
      now: 1000 + PROVISIONAL_POLICY.minIntervalMs - 100,
      inFlight: false,
      requestsThisUtterance: 1,
    });
    expect(decision.reason).toBe('throttled');
  });

  it('cancels a stale in-flight request instead of waiting forever', () => {
    const decision = decideProvisional({
      utterance: 'could you explain why the deployment is failing on production',
      lastRequestedText: 'could you',
      lastRequestedAt: 1000,
      now: 1000 + PROVISIONAL_POLICY.inFlightGraceMs + 50,
      inFlight: true,
      requestsThisUtterance: 1,
    });
    expect(decision.action).toBe('request');
    expect(decision.cancelInFlight).toBe(true);
  });

  it('stops spending once the per-utterance budget is gone', () => {
    const decision = decideProvisional({
      utterance: 'could you explain why the deployment is failing on production right now',
      lastRequestedText: 'could',
      lastRequestedAt: 0,
      now: 99999,
      inFlight: false,
      requestsThisUtterance: PROVISIONAL_POLICY.maxRequestsPerUtterance,
    });
    expect(decision.reason).toBe('budget-exhausted');
  });
});

describe('refined policy', () => {
  it('requests a refinement for a completed question (criterion 6)', () => {
    expect(
      decideRefined({ utterance: 'Could you explain why the app is slow today?', lastRefinedFor: '', inFlight: false })
        .action,
    ).toBe('request');
  });

  it('does not refine the same utterance twice', () => {
    const utterance = 'Could you explain why the app is slow today?';
    expect(decideRefined({ utterance, lastRefinedFor: utterance, inFlight: false }).reason).toBe('unchanged');
  });

  it('refines with a superseded provisional still in flight', () => {
    const decision = decideRefined({
      utterance: 'Could you share the timeline for the payment module?',
      lastRefinedFor: '',
      inFlight: true,
    });
    expect(decision.action).toBe('request');
    expect(decision.cancelInFlight).toBe(true);
  });
});

describe('stale reply protection (criterion 7)', () => {
  it('drops an older reply that arrives late', () => {
    const current = reply({ version: 7, stage: 'refined', suggestedReply: 'Ready' });
    const late = reply({ version: 5, stage: 'provisional', suggestedReply: 'Stale' });
    const decision = pickReplyForDisplay(current, late);
    expect(decision.reply?.suggestedReply).toBe('Ready');
    expect(decision.discardedStale).toBe(true);
  });

  it('accepts the newest reply and equal-version refreshes', () => {
    expect(pickReplyForDisplay(null, reply({ version: 1 })).reply?.version).toBe(1);
    expect(pickReplyForDisplay(reply({ version: 2 }), reply({ version: 3 })).discardedStale).toBe(false);
    const equal = pickReplyForDisplay(reply({ version: 3, suggestedReply: 'a' }), reply({ version: 3, suggestedReply: 'b' }));
    expect(equal.reply?.suggestedReply).toBe('b');
    expect(equal.discardedStale).toBe(false);
  });

  it('only the newest sequencer version counts as current', () => {
    const sequencer = createSequencer();
    const first = sequencer.begin();
    const second = sequencer.begin();
    expect(sequencer.isLatest(first)).toBe(false);
    expect(sequencer.isLatest(second)).toBe(true);
    expect(sequencer.latest()).toBe(second);
  });
});

describe('latency summary', () => {
  it('computes each milestone gap', () => {
    const summary = summarizeLatency({
      speechAt: 1000,
      transcriptAt: 1300,
      requestAt: 1350,
      replyAt: 2100,
    });
    expect(summary.speechToTranscriptMs).toBe(300);
    expect(summary.transcriptToRequestMs).toBe(50);
    expect(summary.requestToReplyMs).toBe(750);
    expect(summary.speechToReplyMs).toBe(1100);
  });

  it('reports null instead of guessing when a milestone is missing', () => {
    const summary = summarizeLatency({ speechAt: 1000, transcriptAt: null });
    expect(summary.speechToTranscriptMs).toBeNull();
    expect(summary.speechToReplyMs).toBeNull();
  });
});

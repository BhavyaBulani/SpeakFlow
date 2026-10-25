import type { ReplyTone } from './types';

/**
 * The response library: the local fast path.
 *
 * Why this exists
 * ---------------
 * The provisional reply is the expensive part of this product. It fires
 * repeatedly while someone is still talking, and until now every firing was a
 * paid (or quota-limited) model request. This library replaces the common cases
 * with a deterministic local match that costs nothing and returns in
 * microseconds.
 *
 * The safety property that makes it usable
 * ---------------------------------------
 * A library record NEVER answers a factual question. It acknowledges, buys time,
 * asks for clarification, or confirms understanding. That is exactly what a
 * provisional reply should be, because a partial sentence cannot justify a
 * factual answer. So the fast path is not a cheaper imitation of the model - it
 * is the *correct* answer for the provisional stage, and the model is reserved
 * for the refined stage where the full utterance is available.
 *
 * Every string here is written to be spoken aloud: short, plain, and free of
 * commitments. No placeholders means no invented facts.
 */

export type ResponseCategory =
  | 'acknowledge-question'
  | 'ask-clarification'
  | 'confirm-understanding'
  | 'explain-blocker'
  | 'negotiate-deadline'
  | 'missed-deadline'
  | 'project-status'
  | 'ask-for-time'
  | 'disagree-politely'
  | 'correct-misunderstanding'
  | 'express-uncertainty'
  | 'confirm-next-step'
  | 'ask-repeat'
  | 'out-of-scope'
  | 'verify-before-committing';

export interface ResponseRecord {
  id: string;
  category: ResponseCategory;
  /**
   * Phrases whose presence makes this record relevant. Matching is on
   * normalized text (lowercase, punctuation stripped) and a phrase may be a
   * single word or several.
   */
  cues: string[];
  /** The default (professional) reply. */
  reply: string;
  /** Optional tone-specific rewrites. Missing tones fall back to `reply`. */
  variants?: Partial<Record<ReplyTone, string>>;
  alternatives: string[];
  needsClarification: boolean;
}

/**
 * Records are ordered by specificity: a two-word cue outranks a one-word cue
 * because "not sure" in the cue list is more meaningful than "sure".
 */
export const RESPONSE_LIBRARY: readonly ResponseRecord[] = [
  {
    id: 'ask-repeat',
    category: 'ask-repeat',
    cues: ['sorry what', 'did not catch', 'didn t catch', "couldn't hear", 'say that again', 'repeat that', 'you are breaking up', 'breaking up', 'cutting out', 'connection is bad'],
    reply: 'Sorry, you are breaking up a little. Could you say that again?',
    variants: {
      friendly: 'Sorry, I lost part of that - could you say it once more?',
      concise: 'Sorry, you cut out. Again please?',
    },
    alternatives: [
      'I missed part of that. Could you repeat it?',
      'The audio dropped out for a moment. Can you say that again?',
    ],
    needsClarification: true,
  },
  {
    id: 'slow-down',
    category: 'ask-repeat',
    cues: ['speak slowly', 'too fast', 'slow down', 'very quickly', 'really fast'],
    reply: 'Could you slow down just a little so I get every detail?',
    alternatives: ['I want to make sure I capture this correctly - could you go a bit slower?'],
    needsClarification: true,
  },
  {
    id: 'deadline-push',
    category: 'negotiate-deadline',
    cues: ['deadline', 'move the deadline', 'push the deadline', 'extend the deadline', 'by friday', 'by tomorrow', 'by monday', 'end of day', 'end of the week', 'eod', 'deliver by', 'ship by', 'can you finish'],
    reply: 'Let me check where that lands with the current work and confirm the date with you.',
    variants: {
      diplomatic: 'I want to give you a date I can actually hold, so let me confirm that and come back to you today.',
      confident: 'Let me verify the schedule and I will confirm a date you can rely on.',
    },
    alternatives: [
      'I will check the timeline and confirm the exact date shortly.',
      'Let me confirm what is realistic before I commit to that date.',
    ],
    needsClarification: false,
  },
  {
    id: 'more-time',
    category: 'ask-for-time',
    cues: ['how long', 'when will', 'timeline', 'eta', 'how much time', 'still working'],
    reply: 'I need a little more time on this. Let me finish the check and come back to you.',
    variants: {
      concise: 'I need a bit more time to confirm.',
      friendly: 'I am nearly there - I just need a little more time to check before I give you a number.',
    },
    alternatives: [
      'I want to verify this properly before I answer, so let me come back shortly.',
      'Let me spend a little more time on it so the answer is accurate.',
    ],
    needsClarification: false,
  },
  {
    id: 'out-of-scope',
    category: 'out-of-scope',
    cues: ['also add', 'also need to add', 'need to add', 'one more thing', 'while you are at it', 'can you also', 'small change', 'just a quick change', 'scope'],
    reply: 'That is a separate piece of work, so let me check the scope and priorities before I take it on.',
    variants: {
      diplomatic: 'I can look at that, though it sits outside what we agreed for this round. Let me check how it fits with the priorities.',
    },
    alternatives: [
      'Let me confirm that against the current scope so I do not quietly change what we agreed.',
      'I want to make sure that does not slip something else, so let me check the priorities first.',
    ],
    needsClarification: false,
  },
  {
    id: 'disagree',
    category: 'disagree-politely',
    cues: ['wrong', 'that is not correct', 'you should', 'why did you', 'you forgot', 'you broke', 'should have', 'blame', 'your fault'],
    reply: 'I see it differently, so let me walk you through what I am seeing and we can settle it together.',
    variants: {
      diplomatic: 'I understand why it looks that way. From my side the picture is a little different, so let me share what I have.',
      empathetic: 'I can see why that is frustrating. Let me share what I am seeing so we can compare notes.',
    },
    alternatives: [
      'Let me check that against what I have, because my understanding is different.',
      'I want to be direct here: I do not think that is what happened. Let me show you.',
    ],
    needsClarification: false,
  },
  {
    id: 'explain-blocker',
    category: 'explain-blocker',
    cues: ['blocked', 'stuck', 'blocker', 'waiting on', 'cannot proceed', 'not able to move', 'dependency'],
    reply: 'I am blocked on one dependency there. Let me confirm the current state and tell you exactly where it stands.',
    variants: {
      concise: 'I am blocked on one dependency. Confirming the state now.',
    },
    alternatives: [
      'There is one thing blocking me, and I want to give you the accurate status rather than a guess.',
    ],
    needsClarification: false,
  },
  {
    id: 'uncertain',
    category: 'express-uncertainty',
    cues: ['are you sure', 'do you know', 'is it true', 'did you check', 'have you tested', 'are you certain', 'can you guarantee', 'sure about'],
    reply: 'I do not want to give you a guess on that. Let me verify and confirm.',
    variants: {
      confident: 'I will not guess on that one. Let me verify it and give you a definite answer.',
    },
    alternatives: [
      'I would rather confirm that than assume, so let me check and get back to you.',
      'Let me verify that before I say it as fact.',
    ],
    needsClarification: false,
  },
  {
    id: 'missed-deadline',
    category: 'missed-deadline',
    cues: ['you missed', 'still not done', 'was due', 'overdue', 'late', 'promised'],
    reply: 'You are right that this is behind where we wanted it. Let me give you the accurate status and a realistic next step.',
    variants: {
      empathetic: 'I understand the delay is inconvenient. Let me be straight with you about where it stands and what I can commit to.',
      diplomatic: 'I am not going to argue the date - it slipped. Let me give you the real position and a next step you can plan around.',
    },
    alternatives: [
      'That did slip, and I want to be honest about why rather than explain it away.',
    ],
    needsClarification: false,
  },
  {
    id: 'status',
    category: 'project-status',
    cues: ['status', 'update', 'where are we', 'how is it going', 'progress', 'what is the state', 'any news'],
    reply: 'Let me give you a quick accurate status rather than a rough one - one moment.',
    variants: {
      concise: 'Short version: let me confirm the exact status and I will tell you now.',
    },
    alternatives: ['I want to give you the real numbers, not an estimate. Let me check first.'],
    needsClarification: false,
  },
  {
    id: 'clarify',
    category: 'ask-clarification',
    cues: ['which one', 'do you mean', 'what do you mean', 'are you asking', 'not sure what', 'clarify', 'explain what you'],
    reply: 'Just so I answer the right thing - which part do you mean exactly?',
    variants: {
      friendly: 'I want to make sure I answer the right question - which part did you mean?',
      concise: 'Which part exactly?',
    },
    alternatives: [
      'Can you point me to the specific piece you mean?',
      'Let me confirm what you are referring to before I answer.',
    ],
    needsClarification: true,
  },
  {
    id: 'confirm-understanding',
    category: 'confirm-understanding',
    cues: ['so what you are saying', 'just to confirm', 'you understand', 'does that make sense', 'right', 'correct'],
    reply: 'Yes, that matches my understanding. Let me confirm it back so we are aligned.',
    variants: {
      confident: 'Yes, that is my understanding too. Let me restate it so we are aligned.',
    },
    alternatives: ['That lines up with what I have. Let me confirm the detail so nothing is missed.'],
    needsClarification: false,
  },
  {
    id: 'next-step',
    category: 'confirm-next-step',
    cues: ['next step', 'what happens now', 'who will', 'who is picking', 'after this', 'then what', 'move forward', 'following up'],
    reply: 'Let me confirm the next step and who is picking it up, so we both leave with the same picture.',
    alternatives: ['Let me restate the next step so we agree on it.'],
    needsClarification: false,
  },
  {
    id: 'verify-fact',
    category: 'verify-before-committing',
    cues: ['can you promise', 'guarantee', 'will you commit', 'can you assure', 'are you certain'],
    reply: 'I do not want to commit to that before I have checked it. Let me confirm and come back to you.',
    variants: {
      diplomatic: 'I would rather not promise something I have not verified. Let me check and give you a straight answer.',
    },
    alternatives: ['Let me verify that first, then I can commit to it properly.'],
    needsClarification: false,
  },
  {
    id: 'acknowledge',
    category: 'acknowledge-question',
    cues: ['could you', 'can you', 'would you', 'will you', 'please', 'do you', 'are you', 'have you', 'is it', 'was it'],
    reply: 'Let me check that and come back to you.',
    variants: {
      friendly: 'Sure - let me take a look and get back to you on that.',
      concise: 'Let me check and confirm.',
      confident: 'I will confirm that and get back to you.',
      diplomatic: 'Let me look into that carefully and give you an accurate answer.',
      empathetic: 'I understand - let me check on that and come back to you.',
    },
    alternatives: [
      'Let me look into that and get back to you.',
      'I want to check the details before I answer, so give me a moment.',
    ],
    needsClarification: false,
  },
];

/** Normalized form used for matching: lowercase, punctuation removed. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface FastPathMatch {
  record: ResponseRecord;
  reply: string;
  alternative: string | null;
  needsClarification: boolean;
  score: number;
  /** Which cue phrases matched, for debugging and the telemetry strip. */
  matchedCues: string[];
}

/** Minimum score before the fast path is allowed to speak. */
export const FAST_PATH_MIN_SCORE = 2;

/**
 * Score one record against the utterance.
 *
 * A multi-word cue is worth the number of words it contains, so "not sure what"
 * (3) beats a bare "please" (1). This is what keeps the specific records
 * outranking the generic acknowledge record that matches almost everything.
 */
function scoreRecord(record: ResponseRecord, haystack: string): { score: number; matched: string[] } {
  let score = 0;
  const matched: string[] = [];

  for (const cue of record.cues) {
    const needle = normalize(cue);
    if (needle.length === 0) continue;
    if (!haystack.includes(needle)) continue;
    const weight = needle.split(' ').length;
    score += weight;
    matched.push(cue);
  }

  return { score, matched };
}

/**
 * Find the best local reply for an utterance.
 *
 * Returns null when nothing scores above the threshold - and returning null is
 * the correct, safe outcome: the caller then either asks the model or shows
 * nothing at all. It must never fall back to a made-up answer.
 */
export function matchFastPath(utterance: string, tone: ReplyTone): FastPathMatch | null {
  const haystack = normalize(utterance);
  if (haystack.length === 0) return null;

  let best: { record: ResponseRecord; score: number; matched: string[] } | null = null;

  for (const record of RESPONSE_LIBRARY) {
    const { score, matched } = scoreRecord(record, haystack);
    if (score < FAST_PATH_MIN_SCORE) continue;
    // Stable tie-break: an earlier (more specific) record wins.
    if (best === null || score > best.score) {
      best = { record, score, matched };
    }
  }

  if (best === null) return null;

  const reply = best.record.variants?.[tone] ?? best.record.reply;
  const alternative = best.record.alternatives[0] ?? null;

  return {
    record: best.record,
    reply,
    alternative,
    needsClarification: best.record.needsClarification,
    score: best.score,
    matchedCues: best.matched,
  };
}

/** Look a record up by id - used by tests and the docs generator. */
export function getRecord(id: string): ResponseRecord | null {
  return RESPONSE_LIBRARY.find((record) => record.id === id) ?? null;
}

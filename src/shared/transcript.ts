import type { TranscriptSegment } from './types';

/**
 * Pure transcript helpers, shared by the browser and the server so that
 * "is this worth a reply?" is decided by one implementation, not two.
 *
 * Everything here is deterministic and dependency-free: it is unit tested in
 * tests/transcript.test.ts.
 */

const QUESTION_MARKER =
  /(\?|\b(could|can|would|will|why|what|when|where|who|whom|which|how|do|does|did|is|are|was|were|should|shall|may|might)\b)/i;

/** Words that almost always mean the sentence is not finished yet. */
const DANGLING_TAIL =
  /\b(and|but|or|because|so|that|to|of|for|with|in|on|at|the|a|an|is|are|was|were|will|would|can|could|should|if|when|while|which|than|as|by|from|about|like|just|really|uh|um|er)\s*$/i;

const FILLER_ONLY = /^(uh|um|erm|hmm|ah|okay|ok|yeah|yes|so|and|the|a)+$/i;

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(text: string): string[] {
  const normalized = normalizeText(text);
  return normalized.length === 0 ? [] : normalized.split(' ');
}

export function wordCount(text: string): number {
  return tokenize(text).length;
}

export function lastWord(text: string): string {
  const tokens = tokenize(text);
  return tokens.length === 0 ? '' : (tokens[tokens.length - 1] as string);
}

/** 0 = identical word sets, 1 = nothing in common. */
export function jaccardDistance(a: string, b: string): number {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : 1 - intersection / union;
}

/** How many words in `next` did not appear in `prev`. */
export function countNewWords(prev: string, next: string): number {
  const prevTokens = new Set(tokenize(prev));
  let fresh = 0;
  for (const token of tokenize(next)) if (!prevTokens.has(token)) fresh += 1;
  return fresh;
}

export function hasQuestionMarker(text: string): boolean {
  return QUESTION_MARKER.test(text);
}

/** True when the sentence looks cut off mid-thought. */
export function looksUnfinished(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  if (wordCount(trimmed) < 2) return true;
  if (/[,;:\-–—]$/.test(trimmed)) return true;
  return DANGLING_TAIL.test(trimmed);
}

export function isFillerOnly(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length === 0 || FILLER_ONLY.test(trimmed);
}

/** Do we have enough to attempt a useful reply at all? */
export function hasMeaningfulContext(text: string, minWords = 4): boolean {
  if (isFillerOnly(text)) return false;
  return wordCount(text) >= minWords;
}

export interface MaterialChangeResult {
  changed: boolean;
  jaccardDistance: number;
  newWords: number;
  /** Why we consider it changed - useful in the latency/telemetry strip. */
  reason: 'first' | 'rephrased' | 'extended' | 'became-question' | 'unchanged';
}

/**
 * Decides whether new speech meaningfully changes the interpretation.
 *
 * Rules (deliberately conservative - every `true` costs an AI request):
 *  - no previous text at all            -> changed (first pass)
 *  - word set differs a lot (rephrased) -> changed
 *  - 4+ new words appended             -> changed
 *  - a question appeared that was not there before -> changed
 */
export function detectMaterialChange(prev: string, next: string): MaterialChangeResult {
  const distance = jaccardDistance(prev, next);
  const newWords = countNewWords(prev, next);

  if (prev.trim().length === 0) {
    return { changed: true, jaccardDistance: distance, newWords, reason: 'first' };
  }

  // A pure extension (every earlier word still present) that adds four or more
  // new words is the common case mid-question: the client is still talking.
  // Checked before the distance test so the label stays truthful - a superset
  // is an extension, not a rephrase.
  const prevTokens = new Set(tokenize(prev));
  const nextTokens = new Set(tokenize(next));
  let kept = 0;
  for (const token of prevTokens) if (nextTokens.has(token)) kept += 1;
  const isPureExtension = kept === prevTokens.size && nextTokens.size > prevTokens.size;

  if (isPureExtension && newWords >= 4) {
    return { changed: true, jaccardDistance: distance, newWords, reason: 'extended' };
  }
  if (distance > 0.34) {
    return { changed: true, jaccardDistance: distance, newWords, reason: 'rephrased' };
  }
  if (newWords >= 4) {
    return { changed: true, jaccardDistance: distance, newWords, reason: 'extended' };
  }
  // An explicit question mark appearing where there was none changes the job
  // from listening to answering. Checked on terminal punctuation, not on
  // auxiliary words, so "the app is slow" does not count as a question.
  const prevAsked = /\?\s*$/.test(prev.trim());
  const nextAsked = /\?\s*$/.test(next.trim());
  if (!prevAsked && nextAsked) {
    return { changed: true, jaccardDistance: distance, newWords, reason: 'became-question' };
  }
  return { changed: false, jaccardDistance: distance, newWords, reason: 'unchanged' };
}

/** Keep the most recent speech when trimming to a character budget. */
export function trimToChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const sliced = text.slice(text.length - maxChars);
  const firstSpace = sliced.indexOf(' ');
  return firstSpace === -1 ? sliced : sliced.slice(firstSpace + 1);
}

export function lastFinalSegments(segments: readonly TranscriptSegment[], turns: number): string[] {
  const finals = segments.filter((segment) => segment.final && segment.text.trim().length > 0);
  return finals.slice(Math.max(0, finals.length - turns)).map((segment) => segment.text.trim());
}

/** True when at least one segment ends with the given id. */
export function isLatestSegment(segments: readonly TranscriptSegment[], id: string): boolean {
  const last = segments[segments.length - 1];
  return last !== undefined && last.id === id;
}

/**
 * Compose the context block handed to the model. Kept as plain text with clear
 * delimiters so the prompt can instruct the model that this is untrusted data.
 */
export function composeContextBlock(input: {
  recentFinals: readonly string[];
  utterance: string;
  maxChars: number;
  utteranceUnfinished: boolean;
}): string {
  const finals = input.recentFinals.map((line, index) => `[${index + 1}] ${line}`).join('\n');
  const parts = [
    input.recentFinals.length > 0
      ? `EARLIER FINAL UTTERANCES (oldest first):\n${finals}`
      : 'EARLIER FINAL UTTERANCES: (none - this is the start of the call)',
    `CURRENT UTTERANCE${input.utteranceUnfinished ? ' (still being spoken, may be incomplete)' : ' (finished)'}:\n"""${input.utterance}"""`,
  ];
  return trimToChars(parts.join('\n\n'), input.maxChars);
}

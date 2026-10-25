import { performance } from 'node:perf_hooks';
import { PROVISIONAL_POLICY, decideProvisional } from '../src/shared/replyPipeline.ts';
import { matchFastPath, RESPONSE_LIBRARY } from '../src/shared/responseLibrary.ts';
import { detectMaterialChange, wordCount } from '../src/shared/transcript.ts';

/**
 * Pipeline benchmark (prompt 2 §8).
 *
 * Scope, stated honestly: this measures the parts that run on this machine with
 * no credentials — transcript normalisation, the trigger decision, and the local
 * reply library. It does NOT measure speech-to-text or hosted model latency,
 * because those need a provider key and real audio. The report says so instead
 * of implying an end-to-end number.
 *
 * Run:  npm run bench
 */

const ITERATIONS = 2000;

/** Synthetic but realistic partial utterances, with no private content. */
const PARTIALS = [
  'Could you explain why the',
  'Could you explain why the application is taking longer to',
  'Could you explain why the application is taking longer to load today',
  'So the client is asking whether we can move the deadline to Friday',
  'I am not sure what you mean by that exactly',
  'Can you confirm the next step and who is picking it up',
  'The audio is breaking up a little on my side',
  'We also need to add reporting to the same sprint',
];

function timeIt(label, fn, iterations = ITERATIONS) {
  // Warm up so JIT compilation is not counted as latency.
  for (let i = 0; i < 200; i += 1) fn(i);

  const samples = new Float64Array(iterations);
  for (let i = 0; i < iterations; i += 1) {
    const start = performance.now();
    fn(i);
    samples[i] = performance.now() - start;
  }

  const sorted = Array.from(samples).sort((a, b) => a - b);
  const pick = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;

  return {
    label,
    iterations,
    mean,
    p50: pick(0.5),
    p95: pick(0.95),
    max: sorted[sorted.length - 1],
  };
}

function fmt(ms) {
  if (ms < 0.001) return '<0.001 ms';
  if (ms < 1) return `${ms.toFixed(3)} ms`;
  return `${ms.toFixed(2)} ms`;
}

function print(rows) {
  const width = Math.max(...rows.map((r) => r.label.length));
  for (const row of rows) {
    console.log(
      `  ${row.label.padEnd(width)}  p50 ${fmt(row.p50).padStart(10)}   p95 ${fmt(row.p95).padStart(10)}   max ${fmt(row.max).padStart(10)}`,
    );
  }
}

console.log('\nSpeakFlow pipeline benchmark');
console.log(`iterations per measurement: ${ITERATIONS}\n`);

// --- 1. Fast path: can a partial get a usable suggestion this fast? ----------
const matchRows = PARTIALS.map((utterance) =>
  timeIt(`matchFastPath(${wordCount(utterance)}w)`, () => matchFastPath(utterance, 'professional')),
);

const combined = timeIt('matchFastPath(mean of samples)', (i) => {
  matchFastPath(PARTIALS[i % PARTIALS.length], 'professional');
});

console.log('1. Local reply library (the ₹0 provisional path)');
print([...matchRows, combined]);

// --- 2. Trigger decision -----------------------------------------------------
const changeRow = timeIt('detectMaterialChange', (i) => {
  detectMaterialChange(PARTIALS[i % 4], PARTIALS[(i % 4) + 1] ?? PARTIALS[0]);
});

const decisionRow = timeIt('decideProvisional', (i) => {
  decideProvisional({
    utterance: PARTIALS[i % PARTIALS.length],
    lastRequestedText: i % 2 === 0 ? '' : PARTIALS[(i - 1) % PARTIALS.length],
    lastRequestedAt: 0,
    now: 1_000_000 + i,
    inFlight: false,
    requestsThisUtterance: 0,
    utteranceStartedAt: 999_000,
  });
});

console.log('\n2. Trigger policy (runs on every partial transcript)');
print([changeRow, decisionRow]);

// --- 3. Coverage: how often does the free path answer at all? ----------------
console.log('\n3. Library coverage on the synthetic partials');
for (const utterance of PARTIALS) {
  const match = matchFastPath(utterance, 'professional');
  const verdict =
    match === null
      ? 'no match  -> would ask the model'
      : `hit (${match.record.category}, score ${match.score})`;
  console.log(`  ${verdict.padEnd(46)} <- "${utterance.slice(0, 46)}"`);
}

// --- 4. Honest statement of what was NOT measured ----------------------------
console.log('\n4. Not measured here (needs a provider key + real audio)');
console.log('  - audio capture to first audio frame');
console.log('  - first audio frame to first STT partial');
console.log('  - LLM request to first token / to completed reply');
console.log('  - end-to-end speech -> suggestion');
console.log('  Those require OPENAI_API_KEY (realtime streaming) or STT_API_KEY');
console.log('  (chunked), plus a real meeting tab. See docs/BENCHMARKS.md.\n');

// --- Exit non-zero if the free path is slower than the product target --------
const budget = 1; // prompt 2 §8 target: ~1 s to a usable provisional suggestion
const worst = combined.p95;
if (worst > budget) {
  console.error(
    `FAIL  local fast path p95 ${fmt(worst)} exceeds the ${budget}s provisional target.`,
  );
  process.exit(1);
}

console.log(
  `PASS  local fast path p95 ${fmt(worst)} is far inside the ${budget}s provisional target ` +
    `(library has ${RESPONSE_LIBRARY.length} records; trigger cap ${PROVISIONAL_POLICY.maxRequestsPerUtterance}/utterance).`,
);
console.log('      Note: this is the reply-generation stage only, not end-to-end.\n');

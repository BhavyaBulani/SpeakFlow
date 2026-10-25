/**
 * Compare local Whisper models on the same real audio: speed AND accuracy.
 *
 * Speed alone is a useless trade-off without the accuracy cost, so this scores
 * every transcript against known ground truth with a real word error rate
 * (Levenshtein alignment over words: substitutions + deletions + insertions).
 *
 * Two conditions are scored, because clean synthetic speech does not
 * discriminate between models:
 *   clean  - the WAV exactly as synthesised
 *   noisy  - the same WAV with white noise mixed in at a fixed SNR, which is a
 *            crude but honest stand-in for a real headset call with compression
 *            and background sound. Deterministic, so runs are reproducible.
 *
 * Both models go through the shipped `WhisperCppSttClient`, so this measures
 * production code rather than a hand-rolled whisper invocation.
 *
 * Prerequisites:
 *   .local-models/Release/whisper-cli.exe
 *   .local-models/corpus/*.wav        (scripts/make-test-corpus.ps1)
 *
 * Run:  npm run bench:models
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { WhisperCppSttClient } from '../src/server/services/whisperCpp.ts';

const CLI_BIN = process.env.WHISPER_CPP_BIN ?? '.local-models/Release/whisper-cli.exe';
const CORPUS_JSON = process.env.SPEECH_CORPUS_JSON ?? 'scripts/test-corpus.json';
const CORPUS_DIR = process.env.SPEECH_CORPUS_DIR ?? '.local-models/corpus';
const ITERATIONS = Number(process.env.BENCH_ITERATIONS ?? 2);
/** SNR in dB for the degraded condition. Lower = noisier. */
const NOISY_SNR_DB = Number(process.env.BENCH_SNR_DB ?? 10);

const MODELS = (
  process.env.BENCH_MODELS ?? '.local-models/ggml-tiny.en.bin,.local-models/ggml-base.en.bin'
)
  .split(',')
  .map((m) => m.trim())
  .filter((m) => m.length > 0);

function fail(message) {
  console.error(`FAIL  ${message}`);
  process.exit(1);
}

// ---- scoring ---------------------------------------------------------------

/**
 * Lowercase, strip punctuation, drop hyphens *without* splitting on them, and
 * collapse spaces.
 *
 * Hyphens are removed rather than replaced with a space on purpose: whisper
 * writes "back-end" where the reference says "backend", and scoring that as one
 * substitution plus one deletion invents an error that no human would call a
 * misrecognition.
 */
function normaliseWords(text) {
  return text
    .toLowerCase()
    .replace(/-/g, '')
    .replace(/[^a-z0-9'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length > 0);
}

/** Levenshtein distance over word arrays. */
function wordDistance(ref, hyp) {
  const rows = ref.length + 1;
  const cols = hyp.length + 1;
  let prev = new Float64Array(cols);
  let curr = new Float64Array(cols);
  for (let j = 0; j < cols; j++) prev[j] = j;

  for (let i = 1; i < rows; i++) {
    curr[0] = i;
    for (let j = 1; j < cols; j++) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[cols - 1];
}

/** Word error rate: edits / reference length. 0 = perfect, 1 = everything wrong. */
export function wordErrorRate(reference, hypothesis) {
  const ref = normaliseWords(reference);
  const hyp = normaliseWords(hypothesis);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  return wordDistance(ref, hyp) / ref.length;
}

// ---- audio degradation -----------------------------------------------------

/** Deterministic PRNG so the noisy condition is reproducible. */
function mulberry32(seed) {
  return function next() {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Locate the `data` chunk in a canonical RIFF WAV instead of assuming offset 44. */
function findDataChunk(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === 'data') return { dataOffset: offset + 8, size: Math.min(size, buffer.length - offset - 8) };
    offset += 8 + size + (size % 2);
  }
  throw new Error('no data chunk');
}

/**
 * Mix white noise into 16-bit mono PCM at a target SNR.
 * Everything else (sample rate, bit depth, header) is preserved.
 */
function addNoise(buffer, snrDb, seed = 12345) {
  const { dataOffset, size } = findDataChunk(buffer);
  const out = Buffer.from(buffer);
  const sampleCount = Math.floor(size / 2);
  if (sampleCount === 0) return out;

  const samples = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) samples[i] = out.readInt16LE(dataOffset + i * 2);

  let sumSquares = 0;
  for (let i = 0; i < sampleCount; i++) sumSquares += samples[i] * samples[i];
  const signalRms = Math.sqrt(sumSquares / sampleCount);
  if (signalRms === 0) return out;

  const noiseRms = signalRms / Math.pow(10, snrDb / 20);
  const rand = mulberry32(seed);

  for (let i = 0; i < sampleCount; i++) {
    // Uniform in [-1, 1] has RMS 1/sqrt(3); scale so the RMS matches the target.
    const noise = (rand() * 2 - 1) * Math.sqrt(3) * noiseRms;
    const mixed = Math.max(-32768, Math.min(32767, Math.round(samples[i] + noise)));
    out.writeInt16LE(mixed, dataOffset + i * 2);
  }
  return out;
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    min: sorted[0],
    p50: at(0.5),
    p95: at(0.95),
    max: sorted.at(-1),
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
  };
}

// ---- prerequisites ---------------------------------------------------------
if (!existsSync(CLI_BIN)) fail(`missing recogniser: ${CLI_BIN}`);
if (!existsSync(CORPUS_JSON)) fail(`missing corpus: ${CORPUS_JSON}`);
if (!existsSync(CORPUS_DIR)) fail(`missing corpus audio: ${CORPUS_DIR}\nRun scripts/make-test-corpus.ps1`);
for (const model of MODELS) if (!existsSync(model)) fail(`missing model: ${model}`);

const corpus = JSON.parse(readFileSync(CORPUS_JSON, 'utf8')).sentences;
const available = new Set(readdirSync(CORPUS_DIR).map((f) => f.replace(/\.wav$/i, '')));
const missingAudio = corpus.filter((s) => !available.has(s.id));
if (missingAudio.length > 0) {
  fail(`corpus audio missing for: ${missingAudio.map((s) => s.id).join(', ')}\nRun scripts/make-test-corpus.ps1`);
}

const CONDITIONS = [
  { id: 'clean', degraded: false },
  { id: `noisy${NOISY_SNR_DB}db`, degraded: true },
];

console.log('\nSpeakFlow local model comparison — speed vs accuracy');
console.log(`corpus: ${corpus.length} sentences   iterations/sentence: ${ITERATIONS}`);
console.log(`conditions: clean, and noisy at ${NOISY_SNR_DB} dB SNR (white noise, deterministic)\n`);

// ---- run -------------------------------------------------------------------
const audioCache = new Map();
function audioFor(sentenceId, degraded) {
  const key = `${sentenceId}:${degraded}`;
  if (!audioCache.has(key)) {
    const raw = readFileSync(`${CORPUS_DIR}/${sentenceId}.wav`);
    audioCache.set(key, new Uint8Array(degraded ? addNoise(raw, NOISY_SNR_DB) : raw));
  }
  return audioCache.get(key);
}

const results = [];

for (const model of MODELS) {
  const name = model.split(/[\\/]/).pop();
  const client = new WhisperCppSttClient({ binaryPath: CLI_BIN, modelPath: model, timeoutMs: 120_000 });

  for (const condition of CONDITIONS) {
    // One warm-up for the whole model+condition so the OS file cache is warm.
    await client.transcribe({ wav: audioFor(corpus[0].id, condition.degraded), language: 'en' });

    const latencies = [];
    const perSentence = [];

    for (const sentence of corpus) {
      const wav = audioFor(sentence.id, condition.degraded);
      let text = '';
      for (let i = 0; i < ITERATIONS; i++) {
        const started = performance.now();
        const result = await client.transcribe({ wav, language: 'en' });
        latencies.push(performance.now() - started);
        text = result.text;
      }
      perSentence.push({
        id: sentence.id,
        reference: sentence.text,
        hypothesis: text,
        wer: wordErrorRate(sentence.text, text),
      });
    }

    results.push({
      name,
      condition: condition.id,
      lat: stats(latencies),
      wer: perSentence.reduce((sum, s) => sum + s.wer, 0) / perSentence.length,
      exact: perSentence.filter((s) => s.wer === 0).length,
      perSentence,
    });
  }
}

// ---- report ----------------------------------------------------------------
for (const condition of CONDITIONS) {
  const rows = results.filter((r) => r.condition === condition.id);
  console.log(`=== ${condition.id} ===\n`);

  const header = ['sentence', ...rows.map((r) => r.name.replace('ggml-', '').replace('.bin', '').padStart(9))].join('  ');
  console.log(header);
  console.log('-'.repeat(header.length));
  for (let i = 0; i < corpus.length; i++) {
    const cells = rows.map((r) => {
      const s = r.perSentence[i];
      return (s.wer === 0 ? 'ok' : `${(s.wer * 100).toFixed(0)}%`).padStart(9);
    });
    console.log([corpus[i].id.padEnd(8), ...cells].join('  '));
  }
  console.log('');
}

console.log('=== summary ===\n');
const head = ['model', 'condition', 'mean WER', 'exact', 'p50 ms', 'p95 ms', 'speed'];
console.log(head.map((h, i) => (i < 2 ? h.padEnd(i === 0 ? 20 : 11) : h.padStart(11))).join(''));

for (const condition of CONDITIONS) {
  const rows = results.filter((r) => r.condition === condition.id);
  const fastest = Math.min(...rows.map((r) => r.lat.p50));
  for (const r of rows) {
    console.log(
      [
        r.name.padEnd(20),
        r.condition.padEnd(11),
        `${(r.wer * 100).toFixed(1)}%`.padStart(11),
        `${r.exact}/${corpus.length}`.padStart(11),
        r.lat.p50.toFixed(0).padStart(11),
        r.lat.p95.toFixed(0).padStart(11),
        `${(r.lat.p50 / fastest).toFixed(2)}x`.padStart(11),
      ].join(''),
    );
  }
}

// Show the actual mistakes rather than hiding behind a mean.
const worst = results
  .flatMap((r) => r.perSentence.map((s) => ({ model: r.name, condition: r.condition, ...s })))
  .filter((s) => s.wer > 0)
  .sort((a, b) => b.wer - a.wer)
  .slice(0, 8);

console.log('');
if (worst.length === 0) {
  console.log('PASS  every model transcribed every sentence exactly in every condition.');
} else {
  console.log('Mistakes, worst first:\n');
  for (const s of worst) {
    console.log(`  ${s.model}  ${s.condition}  ${s.id}  ${(s.wer * 100).toFixed(0)}% wrong`);
    console.log(`    said: "${s.reference}"`);
    console.log(`    got : "${s.hypothesis}"`);
  }
}

console.log('\nNotes:');
console.log('  - Synthetic SAPI speech. Even the noisy condition is white noise mixed');
console.log('    into clean synthesis, not a real accented headset call: read these');
console.log('    numbers as a floor, not a prediction.');
console.log('  - Latency is one chunk of real audio through the real client, with no');
console.log('    capture and no network. See docs/LOCAL_STT.md.\n');

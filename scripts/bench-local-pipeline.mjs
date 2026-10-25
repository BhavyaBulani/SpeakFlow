import { readFileSync } from 'node:fs';
import {
  WhisperCppSttClient,
  isWhisperCppAvailable,
} from '../src/server/services/whisperCpp.ts';
import { matchFastPath } from '../src/shared/responseLibrary.ts';

/**
 * End-to-end verification of the LOCAL pipeline: real speech audio in, real
 * transcript out, real suggestion out. No cloud, no key, no quota.
 *
 * Why this exists: every other test in this repo mocks the recogniser. This is
 * the only check that a human sentence actually becomes text and then a usable
 * reply, using an open-source model on this machine.
 *
 * Prerequisites (see docs/LOCAL_STT.md):
 *   .local-models/Release/whisper-cli.exe
 *   .local-models/ggml-base.en.bin
 *   .local-models/test-speech.wav   (made by scripts/make-test-speech.ps1)
 *
 * Run:  npm run bench:local
 */

const BIN = process.env.WHISPER_CPP_BIN ?? '.local-models/Release/whisper-cli.exe';
const MODEL = process.env.WHISPER_CPP_MODEL ?? '.local-models/ggml-base.en.bin';
const WAV = process.env.SPEECH_TEST_WAV ?? '.local-models/test-speech.wav';

function fail(message) {
  console.error(`FAIL  ${message}`);
  process.exit(1);
}

function pass(message) {
  console.log(`PASS  ${message}`);
}

console.log('\nSpeakFlow LOCAL pipeline check (no cloud, no credentials)\n');

// ---- 0. prerequisites ------------------------------------------------------
if (!isWhisperCppAvailable(BIN, MODEL)) {
  fail(
    `whisper.cpp not found. Expected:\n  ${BIN}\n  ${MODEL}\nSee docs/LOCAL_STT.md.`,
  );
}
pass(`local recogniser present: ${BIN}`);
pass(`local model present:       ${MODEL}`);

let wav;
try {
  wav = new Uint8Array(readFileSync(WAV));
} catch {
  fail(`missing test speech at ${WAV}. Run scripts/make-test-speech.ps1 first.`);
}
pass(`test speech loaded:        ${WAV} (${wav.length} bytes of real audio)`);

// ---- 1. real transcription -------------------------------------------------
const client = new WhisperCppSttClient({ binaryPath: BIN, modelPath: MODEL, timeoutMs: 60_000 });

const t0 = performance.now();
const result = await client.transcribe({ wav, language: 'en' });
const sttMs = performance.now() - t0;

if (result.text.trim().length === 0) {
  fail('the local recogniser returned no text at all');
}
pass(`transcript (${sttMs.toFixed(0)} ms): "${result.text}"`);
pass(`reported mode "${result.mode}" (chunked, not streaming - stated honestly)`);

// The generated sentence is known, so correctness is checkable, not assumed.
const expectedWords = ['explain', 'application', 'longer', 'load'];
const got = result.text.toLowerCase();
const missing = expectedWords.filter((word) => !got.includes(word));
missing.length === 0
  ? pass('transcript contains the words that were actually spoken')
  : fail(`transcript is missing spoken words: ${missing.join(', ')}`);

// ---- 2. reply generation ---------------------------------------------------
const t1 = performance.now();
const match = matchFastPath(result.text, 'professional');
const replyMs = performance.now() - t1;

if (match === null) {
  fail('the local reply library produced no suggestion for a real question');
}
pass(`suggestion (${replyMs.toFixed(3)} ms): "${match.reply}"`);
pass(`matched category "${match.record.category}", engine "local_library"`);

// A provisional reply must never assert a fact it cannot know.
const assertsFact = /because|due to|the cause is/i.test(match.reply);
assertsFact
  ? fail('the provisional reply asserted a cause it cannot know')
  : pass('provisional reply does not assert an unknown fact');

// ---- 3. summary ------------------------------------------------------------
const total = sttMs + replyMs;
console.log('\nMeasured on this machine, real audio, nothing sent off-device:');
console.log(`  speech -> transcript : ${sttMs.toFixed(0)} ms  (local Whisper, ${MODEL})`);
console.log(`  transcript -> reply  : ${replyMs.toFixed(3)} ms  (local library)`);
console.log(`  speech -> suggestion : ${total.toFixed(0)} ms`);

if (total > 1000) {
  console.log(
    `\nNOTE  ${total.toFixed(0)} ms is above the ~1 s target from prompt 2 §8. ` +
      'That is the recogniser, not the reply engine - see docs/BENCHMARKS.md.',
  );
} else {
  console.log('\nPASS  end-to-end local latency is inside the ~1 s provisional target.');
}
console.log('');

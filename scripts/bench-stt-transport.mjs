/**
 * Compare the two local transcription transports on real audio:
 *
 *   cli     - whisper-cli.exe, one process per chunk (startup + model load each time)
 *   server  - whisper-server.exe holding the model in memory, WAV over HTTP
 *
 * Both paths go through the real client classes the server uses, so this
 * measures shipped code rather than a reimplementation.
 *
 * Safety: the server is a CHILD of this script and is killed in a finally
 * block, so the command always terminates (see COVEXCODE.md).
 *
 * Run:  npm run bench:stt
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { WhisperCppSttClient, isWhisperCppAvailable } from '../src/server/services/whisperCpp.ts';
import { WhisperServerSttClient } from '../src/server/services/whisperServer.ts';

const CLI_BIN = process.env.WHISPER_CPP_BIN ?? '.local-models/Release/whisper-cli.exe';
const SERVER_BIN =
  process.env.WHISPER_CPP_SERVER_BIN ?? '.local-models/Release/whisper-server.exe';
const MODEL = process.env.WHISPER_CPP_MODEL ?? '.local-models/ggml-base.en.bin';
const WAV = process.env.SPEECH_TEST_WAV ?? '.local-models/test-speech.wav';
const PORT = Number(process.env.BENCH_PORT ?? 8188);
const ITERATIONS = Number(process.env.BENCH_ITERATIONS ?? 5);

function fail(message) {
  console.error(`FAIL  ${message}`);
  process.exit(1);
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return { min: sorted[0], p50: at(0.5), p95: at(0.95), max: sorted.at(-1), mean };
}

if (!isWhisperCppAvailable(CLI_BIN, MODEL)) {
  fail(`missing recogniser or model:\n  ${CLI_BIN}\n  ${MODEL}\nSee docs/LOCAL_STT.md.`);
}

let wav;
try {
  wav = new Uint8Array(readFileSync(WAV));
} catch {
  fail(`missing test speech at ${WAV}. Run scripts/make-test-speech.ps1 first.`);
}

console.log('\nSpeakFlow local STT transport comparison (real audio, no cloud)\n');
console.log(`audio: ${WAV} (${wav.length} bytes)   iterations: ${ITERATIONS}\n`);

// ---- 1. CLI: one process per chunk -----------------------------------------
const cliClient = new WhisperCppSttClient({ binaryPath: CLI_BIN, modelPath: MODEL, timeoutMs: 120_000 });

// Warm-up is excluded: the first run may touch the OS file cache.
await cliClient.transcribe({ wav, language: 'en' });

const cliSamples = [];
let cliText = '';
for (let i = 0; i < ITERATIONS; i++) {
  const started = performance.now();
  const result = await cliClient.transcribe({ wav, language: 'en' });
  cliSamples.push(performance.now() - started);
  cliText = result.text;
}

// ---- 2. Server: resident model ---------------------------------------------
async function withServer(run) {
  const child = spawn(
    SERVER_BIN,
    ['-m', MODEL, '--host', '127.0.0.1', '--port', String(PORT)],
    { windowsHide: true },
  );
  let boot = '';
  child.stdout.on('data', (b) => (boot += b.toString()));
  child.stderr.on('data', (b) => (boot += b.toString()));

  try {
    const base = `http://127.0.0.1:${PORT}`;
    let ready = false;
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (child.exitCode !== null) break;
      try {
        const res = await fetch(`${base}/`, { signal: AbortSignal.timeout(1000) });
        if (res.status === 200) {
          ready = true;
          break;
        }
      } catch {
        /* still loading the model */
      }
    }
    if (!ready) fail(`whisper-server did not become ready:\n${boot.slice(0, 1200)}`);
    return await run(base);
  } finally {
    child.kill();
    // Give Windows a moment to release the port before the process exits.
    await new Promise((r) => setTimeout(r, 300));
  }
}

let serverSamples = [];

const serverText = await withServer(async (base) => {
  const client = new WhisperServerSttClient({
    serverUrl: base,
    timeoutMs: 120_000,
    language: 'en',
    modelName: MODEL,
  });

  const warm = await client.transcribe({ wav, language: 'en' });
  void warm;
  const samples = [];
  let text = '';
  for (let i = 0; i < ITERATIONS; i++) {
    const started = performance.now();
    const result = await client.transcribe({ wav, language: 'en' });
    samples.push(performance.now() - started);
    text = result.text;
  }
  serverSamples = samples;
  return text;
});

// Assigned inside withServer's callback (declared above).

// The comparison is only meaningful if both transports produced the same text.
if (cliText.trim() !== serverText.trim()) {
  console.log(`NOTE  transports disagree:\n  cli    "${cliText}"\n  server "${serverText}"`);
} else {
  console.log(`PASS  both transports returned the same transcript: "${cliText}"\n`);
}

const cli = stats(cliSamples);
const srv = stats(serverSamples);
const speedup = cli.p50 / srv.p50;

console.log('Per-chunk wall time, same audio, warm OS file cache:');
console.log(
  `  cli    (process per chunk)  min ${cli.min.toFixed(0)}  p50 ${cli.p50.toFixed(0)}  p95 ${cli.p95.toFixed(0)}  max ${cli.max.toFixed(0)} ms`,
);
console.log(
  `  server (resident model)     min ${srv.min.toFixed(0)}  p50 ${srv.p50.toFixed(0)}  p95 ${srv.p95.toFixed(0)}  max ${srv.max.toFixed(0)} ms`,
);
console.log(`\n  p50 improvement: ${speedup.toFixed(2)}x (${(cli.p50 - srv.p50).toFixed(0)} ms saved per chunk)`);

const CHUNK_MS = 2400;
console.log(
  `\n  Text lag behind the speaker, roughly (chunk ${CHUNK_MS} ms + transport):` +
    `\n    cli    ~${(CHUNK_MS + cli.p50).toFixed(0)} ms` +
    `\n    server ~${(CHUNK_MS + srv.p50).toFixed(0)} ms`,
);
console.log('\nNot measured here: capture, network to a hosted provider, or LLM time.');
console.log('Both routes are chunked - no interim partials on either.\n');

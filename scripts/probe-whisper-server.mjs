/**
 * Probe whisper-server.exe so the adapter is written against its real API
 * instead of a guess.
 *
 * Safety: the server is spawned as a CHILD of this script and killed in a
 * finally block, so this command always terminates. (A detached process would
 * be reaped by the harness anyway — see COVEXCODE.md.)
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const BIN = '.local-models/Release/whisper-server.exe';
const MODEL = '.local-models/ggml-base.en.bin';
const WAV = '.local-models/test-speech.wav';
const PORT = 8179;

if (!existsSync(BIN)) {
  console.error(`missing ${BIN}`);
  process.exit(1);
}

/** Run the binary with --help and collect whatever it prints, then kill it. */
async function showHelp() {
  const child = spawn(BIN, ['--help'], { windowsHide: true });
  let out = '';
  child.stdout.on('data', (b) => (out += b.toString()));
  child.stderr.on('data', (b) => (out += b.toString()));
  const done = new Promise((r) => child.on('close', r));
  const timer = setTimeout(() => child.kill(), 5000);
  await done;
  clearTimeout(timer);
  return out;
}

/** Start the server, wait for the health endpoint, then transcribe the WAV. */
async function probeEndpoints() {
  const child = spawn(
    BIN,
    ['-m', MODEL, '--port', String(PORT), '--host', '127.0.0.1'],
    { windowsHide: true },
  );
  let boot = '';
  child.stdout.on('data', (b) => (boot += b.toString()));
  child.stderr.on('data', (b) => (boot += b.toString()));

  const base = `http://127.0.0.1:${PORT}`;
  try {
    // Wait up to 20 s for the model to load.
    let up = false;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const res = await fetch(`${base}/`, { signal: AbortSignal.timeout(1000) });
        if (res.ok || res.status === 404) {
          up = true;
          console.log(`server answered on / with ${res.status}`);
          break;
        }
      } catch {
        /* not up yet */
      }
    }
    if (!up) {
      console.log('server never answered; boot output:\n' + boot.slice(0, 1500));
      return;
    }

    const wav = readFileSync(WAV);
    for (const endpoint of ['/inference', '/v1/audio/transcriptions']) {
      const form = new FormData();
      form.append('file', new Blob([wav], { type: 'audio/wav' }), 'chunk.wav');
      form.append('response_format', 'json');
      form.append('temperature', '0');
      const started = Date.now();
      try {
        const res = await fetch(base + endpoint, {
          method: 'POST',
          body: form,
          signal: AbortSignal.timeout(60000),
        });
        const text = await res.text();
        console.log(
          `${endpoint} -> HTTP ${res.status} in ${Date.now() - started} ms\n  ${text.slice(0, 400)}`,
        );
      } catch (err) {
        console.log(`${endpoint} -> failed: ${err.message}`);
      }
    }
  } finally {
    child.kill();
  }
}

console.log('=== --help ===');
console.log((await showHelp()).slice(0, 2000));
console.log('\n=== endpoints ===');
await probeEndpoints();

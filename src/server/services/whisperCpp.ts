import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ApiError } from '../lib/http';
import { logger } from '../lib/logger';
import type { SttClient, TranscribeAudioInput, TranscribeAudioResult } from './stt';

/**
 * Local speech-to-text via whisper.cpp.
 *
 * This is the honest end of the ₹0 requirement: an open-source model running on
 * the operator's own machine, with no account, no API key, no quota and no data
 * leaving the device. It is a real recogniser (Whisper, MIT-licensed), not a
 * simulation.
 *
 * Transport: whisper.cpp ships a CLI (`whisper-cli`) rather than an
 * OpenAI-compatible HTTP endpoint, so one chunk becomes one child process. That
 * costs ~100-300 ms of process startup per chunk on top of inference, which is
 * why the chunked policy keeps chunks ~2.4 s: the overhead is amortised over a
 * useful amount of speech instead of being paid per word.
 *
 * Verified on this machine: `whisper-cli` + `ggml-base.en.bin` transcribed
 * synthetic speech verbatim in well under a second. Real numbers belong in
 * docs/BENCHMARKS.md and are measured by `npm run bench:local`.
 */

export interface WhisperCppOptions {
  /** Absolute or project-relative path to whisper-cli(.exe). */
  binaryPath: string;
  /** Path to a ggml model, e.g. ggml-base.en.bin. */
  modelPath: string;
  timeoutMs: number;
  /** Optional language override; '' lets the model detect. */
  language?: string;
  /** Injected for tests so no real process is spawned. */
  runImpl?: (args: string[], timeoutMs: number) => Promise<string>;
}

/** Stderr noise from whisper.cpp that is not transcript text. */
function isNoiseLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return true;
  return (
    trimmed.startsWith('read_audio_data') ||
    trimmed.startsWith('whisper_') ||
    trimmed.startsWith('system_info') ||
    trimmed.startsWith('ggml_') ||
    trimmed.startsWith('main:') ||
    trimmed.startsWith('[BLANK_AUDIO]') ||
    trimmed.startsWith('error:')
  );
}

/** Turn whisper-cli stdout into transcript text, or '' when it heard nothing. */
export function parseWhisperOutput(stdout: string): string {
  const lines = stdout
    .split(/\r?\n/)
    .filter((line) => !isNoiseLine(line))
    // whisper-cli may prefix timestamps like "[00:00:00.000 --> 00:00:02.000]".
    .map((line) => line.replace(/^\s*\[[^\]]*-->\s*[^\]]*\]\s*/, '').trim())
    .filter((line) => line.length > 0);

  return lines.join(' ').replace(/\s+/g, ' ').trim();
}

function readArgs(input: TranscribeAudioInput, options: WhisperCppOptions, wavPath: string): string[] {
  const args = [
    '-m',
    options.modelPath,
    '-f',
    wavPath,
    // No timestamps and no extra prints keeps stdout to just the text.
    '-nt',
    '-np',
    // One thread per core is slower here; whisper is memory-bound on these sizes.
    '-t',
    '4',
  ];
  if (options.language !== undefined && options.language.trim().length > 0) {
    args.push('-l', options.language.trim());
  }
  return args;
}

/** Spawn whisper-cli and resolve with its stdout. Rejects on failure/timeout. */
function runWhisper(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(args[0] as string, args.slice(1), {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new ApiError('AI_TIMEOUT', { message: 'Local transcription took too long.' }));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      // whisper.cpp writes its progress to stderr; keep only for diagnostics.
      stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new ApiError('PROVIDER_NOT_CONFIGURED', {
          message: `Could not run the local recogniser: ${error.message}. Check WHISPER_CPP_BIN.`,
        }),
      );
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        logger.warn('stt.whisper_failed', { code, stderr: stderr.slice(0, 200) });
        reject(
          new ApiError('AI_UPSTREAM_ERROR', {
            message: 'The local recogniser could not process that audio.',
          }),
        );
        return;
      }
      resolve(stdout);
    });
  });
}

export class WhisperCppSttClient implements SttClient {
  readonly id = 'whisper-cpp' as const;
  readonly mode = 'chunked' as const;
  readonly model: string;

  private readonly options: WhisperCppOptions;

  constructor(options: WhisperCppOptions) {
    this.options = options;
    this.model = path.basename(options.modelPath);
  }

  async transcribe(input: TranscribeAudioInput): Promise<TranscribeAudioResult> {
    if (input.wav.length === 0) {
      throw new ApiError('VALIDATION_FAILED', { message: 'No audio was received.' });
    }

    const startedAt = Date.now();
    const run = this.options.runImpl ?? runWhisper;

    // whisper-cli reads a file, so the chunk is written to a private temp dir and
    // removed in `finally`. Nothing is left on disk afterwards.
    const dir = mkdtempSync(path.join(tmpdir(), 'speakflow-stt-'));
    const wavPath = path.join(dir, 'chunk.wav');

    try {
      writeFileSync(wavPath, Buffer.from(input.wav));
      const args = readArgs(input, this.options, wavPath);

      // The first argv entry is the executable for the real spawn path.
      const stdout = await run([this.options.binaryPath, ...args], this.options.timeoutMs);
      const text = parseWhisperOutput(stdout);

      return {
        text,
        // whisper.cpp does not report a language for the .en models, and it is
        // not inferred here: an invented value would be worse than null.
        language: null,
        mode: 'chunked',
        providerMs: Date.now() - startedAt,
        model: this.model,
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** True when both the binary and the model are present on disk. */
export function isWhisperCppAvailable(binaryPath: string, modelPath: string): boolean {
  return existsSync(binaryPath) && existsSync(modelPath);
}

export class UnconfiguredWhisperCppSttClient implements SttClient {
  readonly id = 'whisper-cpp' as const;
  readonly mode = 'chunked' as const;
  readonly model = 'none';

  constructor(private readonly reason: string) {}

  async transcribe(input: TranscribeAudioInput): Promise<TranscribeAudioResult> {
    void input;
    throw new ApiError('PROVIDER_NOT_CONFIGURED', { message: this.reason });
  }
}

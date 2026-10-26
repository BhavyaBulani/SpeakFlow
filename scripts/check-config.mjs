// Prints what the server actually resolves from the environment, WITHOUT
// starting it. Run after editing `.env` so you find out which providers are
// really live before hunting a bug in the UI.
//
//   npm run check:config
//
// It imports the same deriveConfig()/providerStatus() the server uses, so it
// cannot drift from the server's view of the world. It also probes the local
// endpoints directly, because `providerStatus()` cannot: the config is loaded
// synchronously, so `aiConfigured` for a local provider means "a local provider
// is SELECTED", not "a model is RUNNING". Those are different questions and the
// second one is the one that decides whether refined replies are real.

import 'dotenv/config';
import { existsSync } from 'node:fs';
import { deriveConfig, toPublicAppConfig } from '../src/server/config.ts';

const config = deriveConfig();
// This is the exact object GET /api/config hands the browser.
const status = toPublicAppConfig(config);

const yes = (value) => (value ? 'yes' : 'no');

console.log('--- resolved config -----------------------------------------');
console.log(`reply provider     ${config.aiProvider}`);
console.log(`reply model        ${config.aiModel}`);
console.log(`reply base URL     ${config.aiBaseUrl}`);
console.log(`stt provider       ${config.sttProvider} (whisper mode: ${config.whisperMode})`);
console.log(`stt model          ${config.sttModel}`);
console.log(`mock AI            ${yes(config.mockAi)}`);

console.log('--- provider status (what /api/config reports) --------------');
console.log(`aiConfigured       ${yes(status.aiConfigured)}`);
console.log(`sttConfigured      ${yes(status.sttConfigured)}`);
console.log(`realtimeConfigured ${yes(status.realtimeConfigured)}`);

// A local provider is never gated on a secret, so the only meaningful question
// left is whether its files are on disk (whisper) or its port answers (a model).
if (config.sttProvider === 'whisper-cpp') {
  const bin = config.whisperMode === 'server' ? config.whisperServerBin : config.whisperBin;
  console.log(`whisper binary     ${bin} -> ${existsSync(bin) ? 'present' : 'MISSING'}`);
  console.log(`whisper model      ${config.whisperModel} -> ${existsSync(config.whisperModel) ? 'present' : 'MISSING'}`);
}

async function probe(label, url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(800) });
    console.log(`${label.padEnd(18)} reachable (HTTP ${response.status})`);
    return true;
  } catch (error) {
    const code = error?.cause?.code ?? error?.name ?? 'unreachable';
    console.log(`${label.padEnd(18)} NOT reachable (${code})`);
    return false;
  }
}

console.log('--- live probes (this is what config alone cannot tell you) --');
const ollamaUp =
  config.aiProvider === 'local' ? await probe('reply model', config.aiBaseUrl) : null;

if (config.sttProvider === 'whisper-cpp' && config.whisperMode === 'server') {
  await probe('whisper server', config.whisperServerUrl);
}

console.log('--- verdict ------------------------------------------------');
if (config.sttProvider === 'whisper-cpp') {
  const localReady = existsSync(config.whisperBin) && existsSync(config.whisperModel);
  console.log(
    localReady
      ? 'speech -> transcript   READY (fully local, no key, no quota)'
      : 'speech -> transcript   BROKEN (whisper binary or model missing - see docs/LOCAL_STT.md)',
  );
}
if (config.aiProvider === 'local') {
  console.log(
    ollamaUp
      ? 'transcript -> refined  READY (real local model will answer)'
      : 'transcript -> refined  SAFE FALLBACK ONLY (nothing on the local endpoint; start the model server)',
  );
}

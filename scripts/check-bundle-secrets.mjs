import fs from 'node:fs';
import path from 'node:path';

/**
 * Guards acceptance criterion: "No secret API keys appear in browser-delivered
 * code."
 *
 * Two checks, deliberately separated:
 *
 *  1. KEY MATERIAL — anything shaped like a real provider credential appearing
 *     in `dist/client` or `extension/`. This is the check that must never fire.
 *
 *  2. CLIENT-SIDE READS OF SERVER SECRETS — `import.meta.env.OPENAI_API_KEY` or
 *     `process.env.OPENAI_API_KEY` in browser code. Vite inlines such reads into
 *     the bundle, so their presence is a genuine leak even without a literal.
 *
 * Note: the bare *name* "OPENAI_API_KEY" in a user-facing help string ("add it
 * to the server .env") is not a leak, and flagging it taught us nothing while
 * failing the build for correct code. That is why check 2 looks for an env read,
 * not the name.
 */

const SCAN_DIRS = [
  { dir: path.join(process.cwd(), 'dist', 'client'), label: 'client bundle', ext: /\.(js|mjs|css|html|map|json|txt)$/i },
  { dir: path.join(process.cwd(), 'extension'), label: 'extension', ext: /\.(js|mjs|html|json)$/i },
];

const KEY_MATERIAL = [
  { name: 'OpenAI API key literal', re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/ },
  { name: 'OpenAI ephemeral key literal', re: /\bek_[A-Za-z0-9]{20,}/ },
  { name: 'Supabase service-role JWT', re: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./ },
];

const SERVER_SECRET_READ =
  /(?:import\.meta\.env|process\.env)[.[\]'"\s]{0,4}(OPENAI_API_KEY|OPENAI_BASE_URL|SUPABASE_SERVICE_ROLE_KEY|APP_ACCESS_TOKEN)/;

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

let failures = 0;
let scanned = 0;

for (const target of SCAN_DIRS) {
  if (!fs.existsSync(target.dir)) {
    console.log(`check:bundle skipped ${target.label} (not built yet)`);
    continue;
  }

  const files = walk(target.dir).filter((file) => target.ext.test(file));
  scanned += files.length;

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const relative = path.relative(process.cwd(), file);

    for (const rule of KEY_MATERIAL) {
      const match = text.match(rule.re);
      if (match) {
        failures += 1;
        console.error(`FAIL ${rule.name} in ${relative} -> ${match[0].slice(0, 10)}…`);
      }
    }

    const secretRead = text.match(SERVER_SECRET_READ);
    if (secretRead) {
      failures += 1;
      console.error(`FAIL client-side read of server secret (${secretRead[1]}) in ${relative}`);
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} secret-exposure check(s) failed. Do not ship this build.`);
  process.exit(1);
}

console.log(`check:bundle OK - scanned ${scanned} files across client bundle and extension, no secrets found.`);

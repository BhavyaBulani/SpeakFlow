# Notes for future sessions on this project

Durable, non-obvious things that cost real time to discover. Keep short.

## Verification must go through a real browser

A served bundle returning HTTP 200 does **not** mean the UI works. The app once
shipped a completely blank `#root` while `/` and `/assets/*.js` both returned
200. Only `scripts/e2e-browser.mjs` (Playwright + Chromium) caught it.

- `npm test` = jsdom render tests + API tests (fast, no browser)
- `npm run test:e2e` = real Chromium against the built server (catches real bugs)
- `scripts/e2e-extension.mjs` = real Chromium loading the unpacked extension
- `index.html` has a deliberate static boot shell plus a `#boot-error` panel; if
  React fails to mount, the reason is written into the DOM instead of a blank page.

## CORS: same-origin browsers still send `Origin`

Module scripts and stylesheets are CORS-mode requests, so the *serving* origin
sends an `Origin` header. An allowlist that omits it rejects `/assets/*.js` with
403 and the SPA never boots. `src/server/app.ts` therefore always allows an
origin equal to the request's own host. Covered by regression tests in
`tests/api.test.ts` — do not "simplify" that middleware back to a plain
allowlist check.

## Long-running processes cannot outlive a tool command

Anything started with `start /B`, `Start-Process`, or a detached
`Win32_Process.Create` still gets reaped when the tool command finishes, so a
server is dead by the next command.

- For verification: let the script own the server as a **child process**
  (`scripts/e2e-browser.mjs` spawns it, probes it, kills it). That terminates, so
  the command is safe.
- `scripts/smoke-test.ps1` is the bounded start→probe→stop alternative.
- Never leave a foreground server in a `run_command`, and never use
  `timeout /t` (fails when stdin is redirected) — use `ping -n N 127.0.0.1 >NUL`.

## Windows shell quoting

`npm run verify` includes ESLint. The config treats Playwright `page.evaluate`
callbacks as browser code, which they are - do not "fix" those `no-undef` reports
by removing globals from the config.

`findstr /C:"a b"` and inline PowerShell `$env:X` / nested quotes get mangled
through `cmd /C`. Symptom: `FINDSTR: Cannot open Files"` or PowerShell parse
errors. Put anything non-trivial in a `.ps1`/`.mjs` script file instead of
composing it inline.

Same trap with git: `git commit -m "..."` where the message spans paragraphs and
mentions a path like `/api/health` gets split into pathspecs by `cmd /C` and dies
with `fatal: Invalid path '/api': No such file or directory`. The `git add` before
it succeeds, so the files sit **staged** while the commit silently never happens.
Write the message to a file and use `git commit -F` (`*.log` is gitignored, so
`.commit-msg.log` is a safe name), then delete it.

## Test selectors vs. UI copy

`getByText(/preliminary/i)` matched the *explainer* text in the guidance list, so
the E2E test passed before any reply existed. Assert on state
(`.script-card[data-stage]`, `data-testid="script-stage"`), not on words that also
appear in prose.

## An MV3 extension CAN be loaded and inspected headlessly

`scripts/e2e-extension.mjs` proves Chrome accepts the manifest, registers the
service worker, exposes `chrome.tabCapture`/`chrome.offscreen`, renders the popup,
and creates+closes the offscreen document. Recipe that works:

- needs the **full** Chromium build (`npx playwright install chromium`), not
  `chromium-headless-shell` — extensions cannot load in the shell
- `launchPersistentContext` with `--headless=new` in `args` and
  `--disable-extensions-except` + `--load-extension`
- find the worker via `context.serviceWorkers()` (may need `waitForEvent('serviceworker')`)
- then `worker.evaluate(...)` can call `chrome.*` APIs directly
- **cannot** be automated: clicking the browser action, so `activeTab` cannot be
granted and `tabCapture.getMediaStreamId` on a real tab stays a manual test.

## Mock mode is honest by construction
`MOCK_AI=1` returns `engine: 'mock'` and the UI badges it `Mock AI`. The mock
provider refuses to mint realtime tokens on purpose. Never make the demo provider
look like live transcription — `docs/PLATFORM_FEASIBILITY.md` and the README both
state which paths need a real key.

## `aiConfigured` answers "selected", not "running"

`deriveConfig()` is synchronous, so it cannot probe a socket. A `local` reply
provider (and `MOCK_AI`) therefore reports `aiConfigured: true` the moment it is
*chosen*: the browser is told AI is ready while nothing is listening on
`127.0.0.1:11434`. Do not "fix" this by requiring a key — that is the keyless-local
bug already fixed in `docs/LOCAL_MODEL.md`, and `tests/localProvider.test.ts`
covers it deliberately.

Use `npm run check:config` instead. It resolves config through the same
`deriveConfig()`/`toPublicAppConfig()` the server uses and then probes the real
endpoints, so it prints actual state rather than intent. Run it after touching
`.env`: the app runs *fine* with a dead refined-reply path (labelled
`safe_fallback`), which is easy to misread as "the model is bad".

## An empty `VITE_API_BASE_URL=` silently drops the `/api` prefix

`src/client/App.tsx` used `import.meta.env.VITE_API_BASE_URL ?? '/api'`. `.env`
ships the variable **empty**, not undefined, so `??` never fired and the base
became `''` — every request went to `/config` instead of `/api/config` and got
the SPA's static-handler 404. The UI then reported "Server unreachable" with the
body of a 404 as the reason, which points at the server rather than the URL.
Fixed with `?.trim()` + `|| '/api'`; keep the falsy check, not `??`.

Same file, related trap: `VocabularyPanel`'s `enabled` prop is `boolean | null`,
where `null` means "config has not loaded yet". Passing `false` while config was
in flight made the panel announce "Saved phrases are not available on this
server" — a false statement about the server, asserted before the browser knew
anything.

`.env` also leaks into `import.meta.env` during vitest, unlike `process.env`:
tests never read `process.env`, but Vite inlines `VITE_*` at transform time. That
is how the empty value broke `tests/ui.test.tsx` while the API suite stayed
green. If a client test fails only on a machine with a `.env`, suspect a `VITE_*`
inline before suspecting the test.

## The reply-liveness probe

`src/server/services/replyLiveness.ts` answers "is the reply model *answering*?",
which `aiConfigured` cannot. It is surfaced on `/api/health` as `replyModel` and
not on `/api/config`: config is synchronous and cacheable, a socket probe is
neither. Any HTTP answer counts as listening (a 401 still proves something is
bound to the port); 5 s TTL, concurrent polls coalesced, never throws.

## Dev machine memory ceiling (not a project bug)
16 GB RAM with ~21 GB of commit demand is what kills things here. CovexCode's
"session actor gone" / IDE freezing under load is Windows terminating the session
process for commit pressure — nothing in this repo causes it.

`npm run verify` chained as one command can exceed the 300 s tool limit under
that load and get **killed mid-vitest**, which looks exactly like a hanging test
(it stops after 2-3 test files). It is not a test bug: run `npm test`,
`npm run check:bundle` and `npm run check:extension` as separate commands and
they pass. Don't debug the suite before checking free memory.

- Measured with `systeminfo | findstr Virtual` (commit limit / in use) and
  `wmic` is **removed** on this Windows build, so use `systeminfo`, not `wmic`.
- 2026-02: page file raised from ~7.9 GB to 16 GB init / 32 GB max via
  `scripts/set-pagefile.ps1` (needs elevation; takes effect after reboot),
  lifting the commit limit from 24 GB to ~48 GB.
- Usual consumers, in order: 24+ Chrome processes (~3.2 GB), **two** IDEs at once
  (Covexcode + Antigravity), duplicate ChatGPT/ChatGPT Classic apps, and leaked
  `chrome-devtools-mcp` node servers (~88 MB each, one per abandoned terminal).
- Workspace size is irrelevant to this: the whole repo is 5.8 MB.
- Watch for a byte-order mark: `COVEXCODE.md` may start with one, so an
  `old_string` copied from the visible first line of a display can fail to match.

## The jsdom UI tests time out under load, and pass alone

`tests/ui.test.tsx` renders the whole React tree. Its first test ("mounts and
shows the live workspace") has a 5 s budget, and rendering can exceed that when
the full suite is competing for memory on this machine — it showed 43 s for the
suite vs 15 s idle. Symptom is a bare `Test timed out in 5000ms` on that one
test while the other 203 pass.

Check it before debugging: run `npx vitest run tests/ui.test.tsx` on its own. If
it passes there, it is load, not a regression. There is no `vitest.config.*`
in this repo (config lives in `vite.config.ts`), so a global `testTimeout` would
have to be added deliberately — worth doing if this starts happening often.

## Adding an AI provider touches four places, not one

The provider id is repeated in `AiProviderId` (`config.ts`), `AiClientId`
(`services/openai.ts`), `ReplyEngine` + `AppConfig['replyProvider']`
(`shared/types.ts`), and **two** zod enums in `shared/schemas.ts`
(`replyResultSchema.engine`, `translateResultSchema.engine`).

Miss the zod ones and everything compiles, the provider is called, and the client
then rejects every reply as `AI_INVALID_OUTPUT`, showing a safe fallback. The
symptom looks like "the model is bad", not "the schema is out of date", and
`npm run typecheck` will not catch it — they are string literals.

Related trap: `isAiConfigured()` used to mean `apiKey !== null`. A local model
server (Ollama, LM Studio) needs no key, so a perfectly working keyless setup
reported itself **unconfigured** and silently served canned replies. "Configured"
must not be defined as "has a secret" — see `docs/LOCAL_MODEL.md`.

## Speech-to-text has two modes that are not interchangeable

`openai-realtime` streams over WebRTC and yields real partials. `openai-compatible`
posts self-contained WAV chunks over HTTP and returns text only when each chunk
closes — so there are **no interim partials**, and the provisional-reply path
cannot be driven by transcript text on that route. Never call the chunked route
"streaming". Details and the framing rules: `docs/STT_PROVIDERS.md`.

## `gh` can hold two accounts, and the *active* one is what pushes

Two accounts can share one keyring. `gh auth status` then looks perfectly healthy
while the **active** one lacks push rights on the target repo, and `git push`
dies with `403 ... denied to <that-account>` — the token is fine, it is simply
the wrong identity.

Read the `Active account: true` line *and* the permissions before diagnosing a 403:

```bash
gh auth status
gh api repos/OWNER/REPO --jq .permissions.push
```

Fixing it needs `gh auth login` as an account that can write the repo (or
`gh auth switch`), not a fresh token for the same account.

After the first push, verify the remote really has the tree with
`git diff --stat HEAD origin/main` (empty output = identical) and
`git ls-tree -r origin/main --name-only`. Do **not** use
`gh api repos/OWNER/REPO/contents` — it 404s here even once the branch exists, so
a 404 from it proves nothing about whether the push worked.

## `deploy_project` can refuse every call in a session

It errors with "a deployment could not be started this turn. It has to be the
only tool call in the turn" even when it genuinely is the only call, with no
prose around it. Retrying does not clear it (seen 5x in one session).

Fallback: `npx vercel login` (interactive — the user must run it; a tool command
has closed stdin), then `npx vercel link --yes` and `npx vercel --prod`. There is
no non-interactive path without `VERCEL_TOKEN`, `~/.vercel/auth.json`,
`%LOCALAPPDATA%/com.vercel.cli/auth.json` or a `.vercel/project.json` link — check
all four before promising a deploy.

## Never hardcode a secret into a tracked file, even "just for a test"

`scripts/` is tracked. A verification script that needs a real token must read it
from `process.env` or `.env` (gitignored), never a literal — a literal is
committed on the very next `git add`. `scripts/verify-access-token.ps1` follows
this: token from env, falling back to parsing `.env`, and it exits with a clear
message when neither is present.

`APP_ACCESS_TOKEN` is invented, not issued — `config.ts` takes any non-empty
`APP_ACCESS_TOKEN` and `lib/auth.ts` constant-time compares it against the
`Bearer` header. Empty string becomes `null`, which disables the gate. Setting it
in the server env is **not enough**: the browser asks for it at runtime in the
settings drawer (`SettingsDrawer.tsx`) and stores it in localStorage, because
`VITE_APP_ACCESS_TOKEN` is deliberately unread — inlining it would ship the
secret to every visitor.

## A Groq key is not automatically the model the preset names

`AI_PROVIDER_PRESETS.groq` defaults to `llama-3.3-70b-versatile`. A free-tier key
may not have that model at all: the call 404s `model_not_found`, `replyEngine`
labels it `safe_fallback`, and the UI shows a holding line. That reads as "the
model is bad", not "the model is absent" — the same failure shape as the stale
zod enum trap above. `GET https://api.groq.com/openai/v1/models` with the key is
the only honest answer for a given account. The 2026-10-29 key saw 11 models,
with no Llama chat model on the list.

Measured with the real engine on that key:

| Model | Latency | Result |
|---|---|---|
| `qwen/qwen3.8-27b` | 396–618 ms | 5/5 answered, then 429 on ITPM |
| `openai/gpt-oss-20b` | 1832 ms | 2/4 — `json_validate_failed` |
| `openai/gpt-oss-120b` | 1301 ms | 2/4 — `json_validate_failed` |

- **The `gpt-oss` models fail Groq's `json_object` mode intermittently** (400
  `json_validate_failed`) on a prompt they answered moments earlier. On a live
  call that is a random holding line, so they are not a safe default.
- **`qwen/qwen3.8-27b` is the default now**, but its free tier caps **ITPM 7020**:
  four rapid replies exhausted it and the fifth returned 429 `AI_RATE_LIMITED`.
  Degradation is correct and labelled, but a rapid demo can hit it.

`npm run check:config` does **not** catch any of this — it only probes `local`
providers, so its section reads `aiConfigured yes` against a model that 404s.
Verify a hosted key by driving the real pipeline: `.data/probe-groq.mjs`
(gitignored, reads the key from `.env`) does exactly that.

## Supabase's API keys are not a `DATABASE_URL`

Supabase hands out a project URL (`https://<ref>.supabase.co`), an `anon` JWT and
an `sb_secret_...` key. All three are for the Supabase client SDK / PostgREST and
are **unused** by this app. `DATABASE_URL` goes straight to `pg`'s
`connectionString` (`services/index.ts` → `createPgPool`), so it must be the
Postgres URI from Dashboard → Project Settings → Database → Connection pooling:

```
postgresql://postgres.<ref>:<DB PASSWORD>@aws-0-<region>.pooler.supabase.com:6543/postgres
```

`<DB PASSWORD>` is set when the project is created and is **not** any of those
three keys. Pasting the project URL in yields a connect failure, not a complaint
about the shape of the value.

**Percent-encode the password.** A `#` in it is a URI *fragment* delimiter, so
`...:<PASSWORD>@db...` does not parse at all (`ERR_INVALID_URL` from `pg`) and a
`@` or `?` truncates it in ways that look correct in the file. Write `#` as `%23`.
The tell is a URL that looks right in `.env` and refuses to connect; the real
password is whatever `decodeURIComponent(new URL(url).password)` returns.

`.data/probe-db.mjs` prints that decoded length plus the host, and
`.data/probe-db-app.mjs` drives the real `SessionStore`/`AiBudget` against it —
create a session, read it back, reserve one budget notch — so a green result
means the app's stores work, not merely that a socket opened.

### The direct Supabase host is IPv6-only, so Vercel cannot use it

`db.<ref>.supabase.co` resolves to a **single IPv6 address** (`2a05:d01c::/32`).
It connects fine from a laptop and fails on Vercel, whose functions are IPv4-only
— and it fails as a connect timeout, which reads like a wrong password or a paused
project rather than a network-family mismatch.

Always use the pooler for a deployed app:

```
postgresql://postgres.<ref>:<PASSWORD>@aws-0-<region>.pooler.supabase.com:6543/postgres
```

- port **6543 = transaction mode** (one connection per request — right for
  serverless); 5432 is session mode on the same host
- the user is **`postgres.<ref>`**, not plain `postgres`
- it resolves to real IPv4 addresses, as it must

`<region>` is discoverable without opening the dashboard: a pooler answers only
for tenants in its own region, so probing candidate hosts with the real password
returns "tenant/user ... not found" everywhere except the correct one.
`.data/find-pooler.mjs` does exactly that (34 candidates; this project is
`aws-0-eu-west-2`). Transaction mode is safe here because every statement is
self-contained (`CREATE TABLE IF NOT EXISTS`, `INSERT ... ON CONFLICT ...
RETURNING`, `SELECT`) — no named prepared statements, no session-level `SET`.

A green probe shows the shared budget is real: `used` climbed 1 → 2 across
two separate processes, which a per-instance counter cannot do.

## The Vercel function entry must import the bundle, not the source

`api/index.js` imports `../dist/server/serverless.js`. It must not import
`../src/server/serverless`. Vercel's build compiles `api/` entries **on their own**
and keeps relative specifiers verbatim, so the shipped file contains an
extensionless path (`/var/task/src/server/serverless`) that Node's ESM resolver
cannot resolve. Every invocation then dies with `ERR_MODULE_NOT_FOUND` before the
handler runs.

The failure mode is nasty because the build succeeds, the SPA serves 200 from the
CDN, and only `/api/*` returns `FUNCTION_INVOCATION_FAILED` — the deploy log says
`Build Completed` and looks clean. Read `vercel logs <url>`, not the build log.

- The entry is **`.js`, not `.ts`** on purpose. As `.ts` the same build reported
  `TS7016: Could not find a declaration file for module '../dist/server/…'`
  (Vercel type-checks the entry) and then deployed anyway; a plain `.js` shim has
  no such check because it has no types to look for.
- `scripts/build-server.mjs` emits **two** bundles: `index.js` (long-running,
  `npm start`) and `serverless.js` (Vercel). `vercel.json`'s `buildCommand` must
  run `build:server` before `build:web` or the file the function imports is absent.
- This project deliberately uses extensionless imports everywhere (one tsconfig
  for `src/shared`), which esbuild resolves and Vercel's per-file emit does not.
  Keep the bundling; don't "fix" the imports by adding `.js` extensions.
- `api/` is outside tsconfig's `include`, so `typecheck` will not catch a broken
  specifier there. `.data/check-serverless-bundle.mjs` loads the built bundle and
  asserts it exports a function, which is cheaper than a deploy to find out.

## `NODE_ENV=production` as a Vercel env var breaks the build

Setting it in Project Settings makes `npm ci` skip devDependencies, so
`vite build` fails with `Command "npm run build:web" exited with 127` — 127 is
"command not found", not a build error. Do not set `NODE_ENV` in Vercel; the
platform sets it for the build already.

## `vercel link` refuses a classic `vercel.json` on CLI 50+

The Vercel CLI with `--yes` auto-detects this layout (Vite root + `api/`) as two
"services" and then rejects the config:

```
The top-level properties functions, installCommand, buildCommand,
outputDirectory, framework cannot be used with `services`
```

There is no opt-out (`VERCEL_SERVICES`, `SKIP_SERVICES`, `DISABLE_SERVICES` are
not read). The workaround needs no config change:

```
vercel project add <name>
vercel link --yes --project <name>
```

Linking to a project that already exists skips the create-flow detection that
raises the error. `--prod` then deploys the classic config fine, because the
deploy path is gated on `VERCEL_USE_EXPERIMENTAL_SERVICES` /
`hasExperimentalServicesConfig` and this repo sets neither.

Related: CLI 59 stores auth in the Windows credential store, not
`~/.vercel/auth.json`, so an older CLI cannot reuse it — `vercel@39` reports
`No existing credentials found`. If a pre-services CLI is ever needed, login must
be redone with that exact version.

## Shell traps hit while deploying (all through `cmd /C`)

- `findstr /C:"a" /C:"b" /C:"c"` honours only the first pattern and then tries
  to open the rest as files (`FINDSTR: Cannot open /C:"b"`). Redirect full output
  to a `.log` and read the file, or use `grep_search`.
- `curl -w "%%{http_code}"` arrives mangled. Get status codes from a `.mjs`
  script using `fetch` instead.
- `node --input-type=module -e "import ..."` has its quotes destroyed. Put the
  snippet in a file.
- Spawning `npx.cmd` from `spawnSync` without `shell: true` throws `EINVAL` on
  Node 20+, and `shell: true` would mangle values containing URL characters. Call
  the CLI entry directly: `spawnSync(process.execPath, [vcEntry, ...args])`.
- A `npm install --prefix` into a directory that already holds another install
  can leave a half-pruned tree (`Cannot find module 'xdg-app-paths/src/lib/index.js'`).
  Install into a fresh directory instead of reusing one.

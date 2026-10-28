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

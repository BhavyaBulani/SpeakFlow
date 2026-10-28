# Deployment

Two supported topologies. They are not interchangeable — pick by where the audio
processing runs, because that is the part a host cannot move.

## A. Single service (Render) — the local stack, hosted

One Node process serves the API and the built SPA. `render.yaml` describes it.

Works only if the machine can reach the recogniser and the reply model. That
means either a self-hosted box, or a plan that lets you run `whisper-cli` and
Ollama alongside the app. A free-tier PaaS cannot: there is no `whisper-cli.exe`
and nothing listening on `127.0.0.1:11434`.

```
STT_PROVIDER=whisper-cpp      # needs the binary + ggml model on that host
AI_PROVIDER=local             # needs Ollama on that host
```

## B. Split (Vercel + a hosted database) — what a public URL needs

- **Frontend + API**: Vercel. `api/index.ts` is the serverless entry; it builds
  the same Express app as `src/server/index.ts` without binding a port and
  without serving static files.
- **Database**: Postgres (Neon, Supabase, Render). Required — see below.
- **Recogniser and reply model**: hosted, i.e. Groq's free tier. The local ones
  cannot be uploaded.

```bash
DATABASE_URL=postgresql://...        # required on Vercel
APP_ACCESS_TOKEN=<long random>       # required before the URL is shared
AI_PROVIDER=groq
AI_API_KEY=<groq key>
STT_PROVIDER=openai-compatible
STT_API_KEY=<groq key>
STT_MODEL=whisper-large-v3-turbo
CORS_ORIGINS=https://<your-app>.vercel.app
```

`AI_PROVIDER=groq` and `STT_PROVIDER=openai-compatible` both speak the OpenAI
wire format, which is why the same key can be used for replies and for speech —
but they are separate variables on purpose, so a key for one can never silently
become the key for the other.

### Why the database is not optional there

Vercel may serve two requests from the same call on two different instances.
`POST /api/sessions` creates the session on one and `POST /api/stt/chunk` looks
for it on another; with an in-memory store that answers `SESSION_NOT_FOUND` and
the call is dead. `DATABASE_URL` switches the store to Postgres
(`src/server/services/sessionStorePostgres.ts`).

The schema is created on first use (`CREATE TABLE IF NOT EXISTS`), so there is
no migration step to forget. `/api/health` reports which store is live:

```json
{ "activeSessions": 1, "sessionStore": "postgres" }
```

`"memory"` on a Vercel deployment is a misconfiguration, not a default.

## What is still per-instance on Vercel (read this before sharing the URL)

These are in-memory by design and reset on every cold start **and** are separate
per instance. On a serverless host that means the limits are weaker than they
look:

| Guard | Where | Behaviour on Vercel |
|---|---|---|
| `AI_DAILY_REQUEST_BUDGET` | `src/server/services/budget.ts` | Per instance, not per day. Two warm instances can spend twice the budget; a cold start resets it. |
| `RATE_LIMIT_MAX` / `AI_RATE_LIMIT_MAX` | `src/server/lib/rateLimit.ts` | Per instance. The effective limit multiplies with instance count. |
| Circuit breaker | `src/server/services/breaker.ts` | Per instance; a tripped breaker elsewhere does not protect this one. |
| `STT_MAX_REQUESTS_PER_SESSION` | `src/server/routes/stt.ts` | Per instance. |

With `APP_ACCESS_TOKEN` set this is a quota nuisance. **Without it, a public
Vercel URL is an open proxy to your model key** whose only real limit is the
provider's own quota. Set the token before sharing.

The durable fix is to move the budget counter into Postgres next to the session
table; it is not done yet.

## Deploying

```bash
npx vercel login          # once
npx vercel link           # once, per project
npx vercel                # preview
npx vercel --prod         # production
```

Set the environment variables in the Vercel dashboard (Project → Settings →
Environment Variables), then redeploy — variables are read at runtime, but a
deployment created before they existed keeps the old values.

Verify after deploying, in this order:

1. `curl https://<app>/api/health` → `status: "ok"`, `sessionStore: "postgres"`,
   `aiConfigured: true`, `replyModel.reachable: true`.
2. `curl -X POST https://<app>/api/sessions -H "Authorization: Bearer $TOKEN"` →
   `201` with an id.
3. Open the URL, press **Start live assistance**, speak. A provisional reply
   should appear, then a refined one.

Step 3 is the only one that proves the product works, and it needs a person and
a microphone — no automated check covers it.

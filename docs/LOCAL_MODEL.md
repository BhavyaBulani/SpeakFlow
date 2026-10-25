# Running a local open-weight model (optional, ₹0)

SpeakFlow can talk to a model running on your own machine instead of a hosted
API. This is the only configuration with **no quota at all**: nothing is metered
except your own electricity, and no conversation leaves the device.

## Read this first — the scope limit

The master spec (§2.4, addendum A) is explicit: **the product must not require
end users to download or run a large model.** Local inference is therefore
supported as an **opt-in operator/developer path only**.

- If you are running SpeakFlow on your own machine and want a guaranteed-₹0
  setup, this is the strongest option available.
- It is **not** the intended path for the end user the product describes (a user
  on a client call, possibly on modest hardware). Those users should use a
  hosted free tier or a paid key.

Do not ship a deployment that only works this way and describe it as the product.

## Hardware reality on this machine

`COVEXCODE.md` records a **16 GB RAM** ceiling with real commit pressure from
Chrome, two IDEs and duplicate apps. Model memory is on top of that.

Rough sizes for 4-bit quantised instruct models:

| Model | Quantised size | Practical here? |
|---|---|---|
| `qwen2.5:3b-instruct` | ~2 GB | **Yes** — the sensible default |
| `qwen2.5:7b-instruct` | ~4.7 GB | Tight; expect swapping under load |
| `llama3.1:8b` | ~4.9 GB | Tight, same as above |
| anything 13B+ | 8 GB+ | No |

The default in `config.ts` is `qwen2.5:7b-instruct`; drop to `3b` if you see the
machine thrash. Reply quality drops noticeably at 3B, especially on the JSON
contract, so expect more safe-fallback replies.

## Setup with Ollama

```bash
ollama pull qwen2.5:3b-instruct
ollama serve            # listens on http://127.0.0.1:11434
```

Then in `.env`:

```env
AI_PROVIDER=local
# No key needed. Leave AI_API_KEY empty.
AI_MODEL=qwen2.5:3b-instruct
```

Start the app and `GET /api/config` should report `aiConfigured: true`,
`replyProvider: "local"`, `replyModel: "qwen2.5:3b-instruct"`.

LM Studio and llama.cpp's server also expose an OpenAI-compatible endpoint. Point
`AI_BASE_URL` at it (LM Studio defaults to `http://127.0.0.1:1234/v1`) and set
`AI_PROVIDER=local`.

## What works, and what degrades

| Capability | With a local model |
|---|---|
| Provisional/refined replies | Works, slower (see latency) |
| Tone controls, translation (Hindi/Hinglish → English) | Depends on the model's multilingual quality |
| Structured output | `json_object` mode — the schema is restated in the prompt, so validation failures are more likely than with OpenAI's enforced `json_schema` |
| Transcription | **Unaffected** — a chat model does not transcribe. You still need a separate STT key, or the demo transcript |

## Honest expectations

- **Latency.** A 3B model on a CPU-only laptop can take several seconds per
  reply, which defeats the point of a *provisional* reply mid-sentence. Measure
  it (the app shows per-reply latency) before deciding this is good enough.
- **JSON reliability.** `jsonMode: json_object` guarantees the reply parses as
  JSON, not that it matches the schema. Invalid output is caught and replaced
  with a labelled safe fallback — you will see the **Fallback** badge more often.
- **No GPU acceleration is configured.** If you have a GPU and want this fast,
  that is an Ollama/llama.cpp setup concern, not a SpeakFlow one.

## Verified here

`tests/localProvider.test.ts` asserts:

- a keyless local config is reported as **configured** (the bug this fixes — a
  working local server used to report itself unconfigured and serve canned
  replies instead of calling the model);
- the default endpoint is loopback, never a public host;
- no `Authorization` header is sent when no key is set, and one *is* sent when
  a key is configured;
- `createServices` builds a real client rather than `UnconfiguredAiClient`.

**Not verified:** a real reply from a real local model. No model is installed in
this environment, so the request shape is tested against a stubbed `fetch`.

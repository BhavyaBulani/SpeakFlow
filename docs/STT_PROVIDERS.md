# Speech-to-text providers

SpeakFlow has two transcription transports. They are **not interchangeable**:
one streams, one does not. The server reports which one is active via
`GET /api/config` (`sttMode`), and the UI and permission explainer change their
wording accordingly.

| | `openai-realtime` | `openai-compatible` |
|---|---|---|
| How audio travels | Browser → provider over WebRTC | Browser → your server → provider |
| Words appear | While the speaker is still talking | When each chunk closes (~1.5–3 s behind) |
| Interim partials | Yes | **No** |
| Preliminary reply before the sentence ends | Possible | **Not from transcript alone** |
| Credential | OpenAI key (paid) | Any OpenAI-compatible key (free tiers exist) |
| Config | `STT_PROVIDER=openai-realtime` | `STT_PROVIDER=openai-compatible` |

## Why the chunked path exists

The ₹0 requirement rules out a paid WebRTC streaming socket as the *only* real
transcription route. The ordinary `POST /audio/transcriptions` endpoint is
available on free tiers, so SpeakFlow implements it properly rather than
pretending it does not exist.

It is deliberately **not** described as streaming anywhere in the product,
because it is not:

- The transcript steps forward one recognised chunk at a time; it does not grow
  word by word.
- There are no interim partials, so the "preliminary reply while the client is
  still speaking" behaviour cannot be driven by transcript text on this path.
- A chunk is only sent once it closes, so the first text necessarily lags the
  speaker by roughly `STT_CHUNK_MS` (or sooner via the silence rule).

## Configuration

```env
STT_PROVIDER=openai-compatible
STT_API_KEY=<your provider key>          # GROQ_API_KEY is also accepted
# STT_BASE_URL=https://api.groq.com/openai/v1
# STT_MODEL=whisper-large-v3-turbo
STT_CHUNK_MS=2400
STT_SILENCE_MS=420
STT_MAX_REQUESTS_PER_SESSION=240
```

`STT_API_KEY` does **not** fall back to `OPENAI_API_KEY` unless the provider is
`openai-realtime`. Borrowing an OpenAI key for a Groq endpoint would fail
authentication at request time; it is treated as absent instead, and the UI
reports transcription as unconfigured.

## How audio is framed

`src/shared/audioFraming.ts` owns all of this, and it is unit tested:

- Audio is decimated to **16 kHz mono** with a box filter in `downsampleTo16k`.
- `ScriptProcessorNode` yields frames of 4096 samples (~256 ms).
- `ChunkAssembler` releases a chunk when the speaker pauses **and** the chunk is
  worth sending, or at the hard maximum (`4200 ms`) mid-sentence. Without the
  second rule a speaker who never pauses would produce one huge chunk and no
  text at all.
- Chunks quieter than `minSpeechRms` are dropped: room tone costs a request and
  returns a hallucinated word or nothing.
- Every chunk is a **complete WAV file** (`encodeWav16k`). This is why
  `MediaRecorder` is not used: its `dataavailable` slices after the first carry
  no container header, so a batch endpoint receives bytes it cannot decode.
- Frames pass through `BoundedFrameQueue` (drop-oldest, counted) so a slow
  provider cannot grow memory without bound, and `SequenceTracker` classifies
  duplicate / out-of-order / gap conditions from the sequence number.

## Server route

`POST /api/stt/chunk` (`src/server/routes/stt.ts`):

- Requires a session this server created (`SESSION_NOT_FOUND` otherwise), so the
  route cannot be used as an open STT proxy.
- Rejects non-RIFF payloads before spending provider quota.
- Caps chunks per session (`STT_MAX_REQUESTS_PER_SESSION`) and returns `429`
  `AI_BUDGET_EXHAUSTED` past it.
- Logs byte counts and the character count of the result — **never the text**.

## Free-tier limits: not verified here

Free quotas, model availability and retention terms change, and this workspace
has **no working web-search tool** (Python/`ddgs` is not installed). No quota
number on this page may be treated as fact.

What you must check against the provider's own current documentation before
relying on any number:

- the free-tier **audio seconds or tokens per day/month**;
- the **requests-per-minute** limit (the chunked path sends far more requests
  than a single streaming socket would);
- whether the free tier permits **commercial** use;
- **data retention**: whether uploaded audio is used for training.

`STT_MAX_REQUESTS_PER_SESSION` and `AI_DAILY_REQUEST_BUDGET` are the two hard
stops that keep a misconfigured or abusive session inside whatever the quota is.
Neither enables paid overage.

## What is verified, and what is not

Verified by automated tests (`tests/audioFraming.test.ts`, `tests/stt.test.ts`):

- the exact multipart body sent to the provider (model, language, `.wav` file);
- the `Authorization` header;
- mapping of 401/429/413/5xx and of timeout versus caller abort;
- RIFF validation, session binding, per-session cap, no key leakage in `/api/config`;
- chunk assembly, gap/duplicate detection, bounded-queue eviction, WAV encoding.

**Not verified:** a real end-to-end transcription against a live provider. That
needs a real key and real speech, which this environment does not have. Treat the
chunked path as *implemented and unit-tested against a mocked provider*, not as
*proven live*.

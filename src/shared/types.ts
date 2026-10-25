/**
 * Types shared by the browser client and the API server.
 *
 * Keeping these in one place is what lets the client reject a malformed AI
 * response instead of rendering `undefined` into the script panel mid-call.
 */

export type ReplyStage = 'provisional' | 'refined';

/** Where a reply came from. `safe_fallback` is never presented as model output. */
export type ReplyEngine =
  | 'openai'
  | 'groq'
  | 'openai-compatible'
  | 'local'
  | 'mock'
  /** Matched a hand-written template locally. Costs nothing; not model output. */
  | 'local_library'
  | 'safe_fallback';

export type Confidence = 'low' | 'medium' | 'high';

export type ClientIntent = 'question' | 'request' | 'feedback' | 'statement' | 'smalltalk' | 'unclear';

export type ReplyTone =
  | 'professional'
  | 'friendly'
  | 'concise'
  | 'confident'
  | 'diplomatic'
  | 'empathetic';

/**
 * The response intent the user is steering toward.
 *
 * Deliberately separate from `ClientIntent`, which classifies what the OTHER
 * person said. Conflating the two would mean the UI could not tell the user
 * "I heard a question" and "act like this" at the same time.
 */
export type ReplyIntent =
  | 'answer'
  | 'clarify'
  | 'ask-for-time'
  | 'acknowledge'
  | 'disagree-politely'
  | 'negotiate'
  | 'explain-delay'
  | 'confirm';

/** One-click rewrite of the script currently on screen. */
export type RefineDirective = 'simpler' | 'shorter' | 'natural' | 'formal';

export interface TranscriptSegment {
  id: string;
  text: string;
  final: boolean;
  /** epoch ms when the segment first appeared */
  startedAt: number;
  /** epoch ms when the segment was finalised (finals only) */
  endedAt?: number;
}

export interface ReplyResult {
  /** Monotonic per-session version. Older versions are discarded by the client. */
  version: number;
  stage: ReplyStage;
  /** The English sentence the user can say out loud. */
  suggestedReply: string;
  alternativeReply: string | null;
  needsClarification: boolean;
  /** Things the user must confirm themselves before saying them as fact. */
  factsToVerify: string[];
  confidence: Confidence;
  intent: ClientIntent;
  engine: ReplyEngine;
  model: string;
  /** Server-measured time from request receipt to validated output. */
  latencyMs: number;
  /** epoch ms when the client received it */
  receivedAt: number;
  /** The transcript text this reply was generated from (for staleness display). */
  forUtterance: string;
  /**
   * Shown to the user when the reply is a degraded fallback (provider timeout,
   * rate limit, unvalidatable output). null when the reply is genuine AI output.
   */
  notice: string | null;
}

export interface SessionInfo {
  id: string;
  createdAt: string;
  expiresAt: string;
  /** Always false: transcripts stay in memory and are never written to disk. */
  transcriptPersisted: boolean;
}

export interface AppConfig {
  version: string;
  environment: string;
  /** True when the server holds a usable provider key. */
  aiConfigured: boolean;
  /** True when the deterministic mock provider is forced on. Labelled in the UI. */
  mockAi: boolean;
  /** True when the server can mint realtime transcription tokens (OpenAI only). */
  realtimeConfigured: boolean;
  /** True when any real transcription route has credentials. */
  sttConfigured: boolean;
  /** Which speech-to-text transport the server is configured for. */
  sttProvider: 'openai-realtime' | 'openai-compatible' | 'whisper-cpp';
  /**
   * `realtime` streams and shows words mid-utterance. `chunked` sends short
   * audio chunks and returns text when each chunk closes - never labelled as
   * streaming, because it is not.
   */
  sttMode: 'realtime' | 'chunked';
  sttModel: string;
  authRequired: boolean;
  /** Which provider actually serves replies. Shown in the UI so it is never guessed. */
  replyProvider: 'openai' | 'groq' | 'openai-compatible' | 'local';
  replyModel: string;
  /** How the provider is asked for structured output. */
  aiJsonMode: 'json_schema' | 'json_object';
  /** Cap on AI calls per server day. 0 means no cap is enforced. */
  aiDailyRequestBudget: number;
  /** True when provisional replies may be answered from the local library. */
  fastPathEnabled: boolean;
  /** Max wait before a provisional reply is forced, even mid-sentence. */
  provisionalMaxWaitMs: number;
  transcribeModel: string;
  transcribeLanguage: string;
  maxTranscriptChars: number;
  contextWindowTurns: number;
  sessionTtlMinutes: number;
  features: {
    vocabulary: boolean;
    vocabularyPersistence: boolean;
  };
}

export interface TranslateRequest {
  text: string;
  targetTone: ReplyTone;
  sourceLanguage: 'auto' | 'hi' | 'hinglish' | 'en';
}

export interface TranslateResult {
  english: string;
  alternatives: string[];
  /** Short note about nuance the user should know (e.g. softened claim). */
  notes: string | null;
  tone: ReplyTone;
  engine: ReplyEngine;
  model: string;
  latencyMs: number;
  notice: string | null;
}

export interface VocabularyItem {
  id: string;
  term: string;
  meaningEn: string;
  meaningHi: string | null;
  example: string | null;
  createdAt: string;
}

export interface RealtimeTokenResponse {
  /** Short-lived browser token (ek_...). The provider API key never leaves the server. */
  token: string;
  expiresAt: number;
  model: string;
  /** WebRTC transport details, so the client does not hardcode provider URLs. */
  transport: {
    kind: 'webrtc';
    sdpUrl: string;
    dataChannel: string;
    inputFormat: 'pcm16';
    sampleRate: number;
  };
}

export type AudioCaptureMode = 'tab' | 'system' | 'microphone' | 'demo';

export type TranscriptionProviderId =
  | 'openai-realtime'
  | 'chunked-stt'
  | 'browser-speech'
  | 'simulated'
  | 'extension-bridge';

export type SessionStatus =
  | 'idle'
  | 'requesting-permission'
  | 'connecting'
  | 'listening'
  | 'reconnecting'
  | 'paused'
  | 'stopped'
  | 'error';

/**
 * What the live pipeline is doing right now.
 *
 * Distinct from `SessionStatus`, which describes the capture connection. The UI
 * must be able to say "transcribing" or "refining reply" rather than showing a
 * generic spinner, because on a live call the difference between "it heard
 * nothing" and "it is thinking" changes what the user does.
 */
export type PipelineStage =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'transcribing'
  | 'generating'
  | 'refining'
  | 'unavailable';

export interface LatencyMarks {
  /** speech detected -> transcript text visible */
  speechToTranscriptMs: number | null;
  /** transcript visible -> reply request fired */
  transcriptToRequestMs: number | null;
  /** request fired -> reply rendered */
  requestToReplyMs: number | null;
  /** speech detected -> reply rendered (the number that matters) */
  speechToReplyMs: number | null;
}

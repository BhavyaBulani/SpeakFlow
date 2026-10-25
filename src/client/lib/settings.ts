import { captureError } from '../../shared/errors';
import type {
  AudioCaptureMode,
  RefineDirective,
  ReplyIntent,
  ReplyTone,
  TranscriptionProviderId,
} from '../../shared/types';

/**
 * User preferences, kept in localStorage on this device.
 *
 * The access token lives here rather than in the bundle: it is a credential the
 * user types in, and a browser-only secret is the honest place for it. Nothing
 * else about a call is persisted.
 */

export interface UserSettings {
  provider: TranscriptionProviderId;
  captureMode: AudioCaptureMode;
  tone: ReplyTone;
  /** null means "let the model decide" rather than implying a default intent. */
  replyIntent: ReplyIntent | null;
  accessToken: string;
  userContext: string;
}

export const DEFAULT_SETTINGS: UserSettings = {
  provider: 'openai-realtime',
  captureMode: 'tab',
  tone: 'professional',
  replyIntent: null,
  accessToken: '',
  userContext: '',
};

const SETTINGS_KEY = 'speakflow.settings.v1';
const CLIENT_ID_KEY = 'speakflow.client-id.v1';

export function loadSettings(): UserSettings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (raw === null) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<UserSettings>;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      provider: isProvider(parsed.provider) ? parsed.provider : DEFAULT_SETTINGS.provider,
      captureMode: isCaptureMode(parsed.captureMode) ? parsed.captureMode : DEFAULT_SETTINGS.captureMode,
      tone: isTone(parsed.tone) ? parsed.tone : DEFAULT_SETTINGS.tone,
      replyIntent: isReplyIntent(parsed.replyIntent) ? parsed.replyIntent : null,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: UserSettings): void {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Private-mode / quota failures must not break a call.
  }
}

/** Stable per-browser id so saved vocabulary stays with this workspace. */
export function getClientId(): string {
  try {
    const existing = window.localStorage.getItem(CLIENT_ID_KEY);
    if (existing !== null && existing.length > 0) return existing;
    const generated =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID().replace(/-/g, '').slice(0, 24)
        : `client${Date.now().toString(36)}`;
    window.localStorage.setItem(CLIENT_ID_KEY, generated);
    return generated;
  } catch {
    return 'local-workspace';
  }
}

function isProvider(value: unknown): value is TranscriptionProviderId {
  return (
    value === 'openai-realtime' ||
    value === 'chunked-stt' ||
    value === 'browser-speech' ||
    value === 'simulated' ||
    value === 'extension-bridge'
  );
}

function isCaptureMode(value: unknown): value is AudioCaptureMode {
  return value === 'tab' || value === 'system' || value === 'microphone' || value === 'demo';
}

function isTone(value: unknown): value is ReplyTone {
  return (
    value === 'professional' ||
    value === 'friendly' ||
    value === 'concise' ||
    value === 'confident' ||
    value === 'diplomatic' ||
    value === 'empathetic'
  );
}

export function isReplyIntent(value: unknown): value is ReplyIntent {
  return (
    value === 'answer' ||
    value === 'clarify' ||
    value === 'ask-for-time' ||
    value === 'acknowledge' ||
    value === 'disagree-politely' ||
    value === 'negotiate' ||
    value === 'explain-delay' ||
    value === 'confirm'
  );
}

export const REPLY_INTENT_LABELS: Record<ReplyIntent, string> = {
  answer: 'Answer',
  clarify: 'Clarify',
  'ask-for-time': 'Ask for time',
  acknowledge: 'Acknowledge',
  'disagree-politely': 'Disagree politely',
  negotiate: 'Negotiate',
  'explain-delay': 'Explain a delay',
  confirm: 'Confirm understanding',
};

export const REFINE_LABELS: Record<RefineDirective, string> = {
  simpler: 'Simpler',
  shorter: 'Shorter',
  natural: 'More natural',
  formal: 'More formal',
};

export const UNSUPPORTED_BROWSER_ERROR = captureError('UNSUPPORTED_BROWSER');

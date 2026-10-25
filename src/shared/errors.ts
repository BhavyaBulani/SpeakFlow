/**
 * Error codes shared by the API and the UI.
 *
 * Every non-2xx response from the API has the shape:
 *   { error: { code: ApiErrorCode, message: string, details?: unknown } }
 * `message` is safe to show to a user: it never contains stack traces,
 * provider payloads or secret material.
 */
export const API_ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHORIZED',
  'RATE_LIMITED',
  'SESSION_NOT_FOUND',
  'PROVIDER_NOT_CONFIGURED',
  'AI_TIMEOUT',
  'AI_RATE_LIMITED',
  'AI_UPSTREAM_ERROR',
  'AI_INVALID_OUTPUT',
  'AI_BUDGET_EXHAUSTED',
  'REQUEST_ABORTED',
  'PAYLOAD_TOO_LARGE',
  'NOT_FOUND',
  'INTERNAL',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

export const API_ERROR_MESSAGES: Record<ApiErrorCode, string> = {
  VALIDATION_FAILED: 'Some of the information sent was not valid. Please check and try again.',
  UNAUTHORIZED: 'This workspace requires an access token. Add it in Settings.',
  RATE_LIMITED: 'Too many requests. Please wait a few seconds and try again.',
  SESSION_NOT_FOUND: 'This call session is no longer active. Start a new session.',
  PROVIDER_NOT_CONFIGURED:
    'The AI provider is not configured on the server. Add AI_API_KEY (or OPENAI_API_KEY) to enable live replies.',
  AI_TIMEOUT: 'The AI took too long to respond. Try again or use a shorter statement.',
  AI_RATE_LIMITED: 'The AI provider is rate limiting us. Retrying shortly.',
  AI_UPSTREAM_ERROR: 'The AI provider returned an error. Please try again.',
  AI_INVALID_OUTPUT: 'The AI returned an unusable answer, so a safe fallback was used.',
  AI_BUDGET_EXHAUSTED:
    'The configured AI request budget for today has been used up, so no new AI call was made. Rules and saved phrases still work. The counter resets at server midnight, or raise AI_DAILY_REQUEST_BUDGET.',
  REQUEST_ABORTED: 'The request was cancelled because newer speech arrived.',
  PAYLOAD_TOO_LARGE: 'The request was too large.',
  NOT_FOUND: 'Not found.',
  INTERNAL: 'Something went wrong on the server. Please try again.',
};

export function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = (value as { error?: unknown }).error;
  if (typeof candidate !== 'object' || candidate === null) return false;
  const { code, message } = candidate as { code?: unknown; message?: unknown };
  return typeof code === 'string' && typeof message === 'string';
}

/** Errors raised by browser audio capture, mapped to human guidance. */
export const CAPTURE_ERROR_CODES = [
  'PERMISSION_DENIED',
  'NO_AUDIO_TRACK',
  'SILENT_AUDIO',
  'UNSUPPORTED_BROWSER',
  'NO_DISPLAY_MEDIA',
  'STREAM_ENDED',
  'PROVIDER_NOT_CONFIGURED',
  'CONNECTION_FAILED',
  'TOKEN_FAILED',
  'UNKNOWN',
] as const;

export type CaptureErrorCode = (typeof CAPTURE_ERROR_CODES)[number];

export interface CaptureError {
  code: CaptureErrorCode;
  message: string;
  hint?: string;
  retryable: boolean;
}

export const CAPTURE_ERROR_MAP: Record<CaptureErrorCode, Omit<CaptureError, 'code'>> = {
  PERMISSION_DENIED: {
    message: 'Permission to capture audio was denied.',
    hint: 'Click the padlock icon in the address bar, allow microphone / screen audio, then try again.',
    retryable: true,
  },
  NO_AUDIO_TRACK: {
    message: 'The selected source has no audio track.',
    hint: 'When you pick a tab in Chrome, tick "Also share tab audio" at the bottom of the picker.',
    retryable: true,
  },
  SILENT_AUDIO: {
    message: 'Audio was received but it is silent.',
    hint: 'The other person may be muted, or tab audio was not shared. Check the meeting app and retry.',
    retryable: true,
  },
  UNSUPPORTED_BROWSER: {
    message: 'This browser cannot capture the required audio.',
    hint: 'Use desktop Chrome or Edge. Tab-audio capture is not available in Safari or Firefox.',
    retryable: false,
  },
  NO_DISPLAY_MEDIA: {
    message: 'Tab audio capture is not supported in this browser or context.',
    hint: 'Use the microphone mode, or open the app in desktop Chrome over https or localhost.',
    retryable: false,
  },
  STREAM_ENDED: {
    message: 'The shared audio stream ended.',
    hint: 'You stopped sharing the tab or the device disconnected. Start assistance again.',
    retryable: true,
  },
  PROVIDER_NOT_CONFIGURED: {
    message: 'Live streaming transcription is not configured on the server.',
    hint: 'Add OPENAI_API_KEY on the server, or switch to Browser speech / Demo transcript.',
    retryable: false,
  },
  CONNECTION_FAILED: {
    message: 'Could not connect to the transcription service.',
    hint: 'Check your network connection. SpeakFlow will retry automatically.',
    retryable: true,
  },
  TOKEN_FAILED: {
    message: 'The server could not issue a transcription token.',
    hint: 'Verify the server is running and OPENAI_API_KEY is valid.',
    retryable: true,
  },
  UNKNOWN: {
    message: 'Audio capture failed for an unknown reason.',
    hint: 'Reload the page and try again.',
    retryable: true,
  },
};

export function captureError(code: CaptureErrorCode, override?: Partial<CaptureError>): CaptureError {
  const base = CAPTURE_ERROR_MAP[code];
  return { code, ...base, ...override };
}

/**
 * Structured logging with a redaction guard.
 *
 * Privacy rule from the spec: transcript content must not end up in logs.
 * Instead of trusting every call site, `log()` drops any field whose key looks
 * like conversation content. Call sites log lengths, stages and timings.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const REDACTED_KEY = /(transcript|utterance|text|reply|content|audio|token|secret|key|authorization)/i;

type Fields = Record<string, unknown>;

function sanitize(fields: Fields): Fields {
  const out: Fields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (REDACTED_KEY.test(key)) {
      if (typeof value === 'string') {
        out[`${key}Length`] = value.length;
        continue;
      }
      if (Array.isArray(value)) {
        out[`${key}Count`] = value.length;
        continue;
      }
      out[key] = '[redacted]';
      continue;
    }
    if (typeof value === 'string' && value.length > 200) {
      out[key] = `${value.slice(0, 200)}…`;
      continue;
    }
    out[key] = value;
  }
  return out;
}

function emit(level: LogLevel, event: string, fields: Fields): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...sanitize(fields),
  });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  debug(event: string, fields: Fields = {}): void {
    if (process.env.NODE_ENV === 'production' && process.env.DEBUG_LOGS !== '1') return;
    emit('debug', event, fields);
  },
  info(event: string, fields: Fields = {}): void {
    emit('info', event, fields);
  },
  warn(event: string, fields: Fields = {}): void {
    emit('warn', event, fields);
  },
  error(event: string, fields: Fields = {}): void {
    emit('error', event, fields);
  },
};

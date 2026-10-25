import { useRef, useState } from 'react';
import type { ReplyTone, TranslateResult } from '../../shared/types';
import { describeApiError, type ApiClient } from '../lib/api';

/**
 * Hindi / Hinglish / English -> natural spoken English composer.
 * Kept separate from the live script so the two never compete for attention.
 */
export function TranslatorPanel({ api, tone }: { api: ApiClient; tone: ReplyTone }) {
  const [text, setText] = useState('');
  const [result, setResult] = useState<TranslateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  const run = async (): Promise<void> => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || busy) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const translated = await api.translate(
        { text: trimmed, targetTone: tone, sourceLanguage: 'auto' },
        controller.signal,
      );
      setResult(translated);
    } catch (err) {
      const described = describeApiError(err);
      if (described.code !== 'REQUEST_ABORTED') setError(described.message);
    } finally {
      setBusy(false);
    }
  };

  const copy = async (value: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setError('Could not copy automatically - select the text and copy it manually.');
    }
  };

  return (
    <section className="panel" aria-labelledby="translator-title">
      <div className="panel-head">
        <span className="panel-title" id="translator-title">
          <span className="glyph">↗</span> Say it in English
        </span>
        <span className="text-[11px] text-ink-3">Hindi · Hinglish · rough English</span>
      </div>

      <div className="p-4 flex flex-col gap-3">
        <label className="sr-only" htmlFor="translator-input">
          What you want to say
        </label>
        <textarea
          id="translator-input"
          className="field"
          rows={2}
          maxLength={2000}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void run();
            }
          }}
          placeholder="Maine issue fix kar diya hai, aap dobara check kar sakte hain."
        />
        <div className="flex items-center justify-between gap-3">
          <span className="text-[11px] text-ink-3">{text.trim().length}/2000 · Ctrl+Enter</span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void run()}
            disabled={busy || text.trim().length === 0}
          >
            {busy ? 'Translating…' : 'Translate'}
          </button>
        </div>

        {error === null ? null : (
          <p className="notice notice-error" role="alert">
            {error}
          </p>
        )}

        {result === null ? (
          <p className="text-xs text-ink-3 leading-relaxed">
            Your meaning is kept exactly as strong as you wrote it - SpeakFlow will not upgrade
            &ldquo;I will check&rdquo; into &ldquo;I have fixed&rdquo;.
          </p>
        ) : (
          <div className="panel-quiet p-3 flex flex-col gap-2">
            <p className="text-[15px] leading-relaxed font-semibold">{result.english}</p>
            {result.alternatives.length > 0 ? (
              <ul className="flex flex-col gap-1 list-none p-0 m-0">
                {result.alternatives.map((alternative) => (
                  <li key={alternative} className="text-[13px] text-ink-2 leading-relaxed">
                    or: {alternative}
                  </li>
                ))}
              </ul>
            ) : null}
            {result.notes === null ? null : (
              <p className="text-xs text-ink-3 leading-relaxed">{result.notes}</p>
            )}
            <div className="flex items-center gap-2 pt-1">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copy(result.english)}>
                {copied ? 'Copied' : 'Copy'}
              </button>
              <span className="text-[11px] text-ink-3 mono">
                {result.engine === 'mock' ? 'MOCK' : result.engine === 'safe_fallback' ? 'FALLBACK' : 'AI'} ·{' '}
                {result.latencyMs}ms
              </span>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

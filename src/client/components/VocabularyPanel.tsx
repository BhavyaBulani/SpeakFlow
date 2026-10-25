import { useCallback, useEffect, useState } from 'react';
import type { VocabularyItem } from '../../shared/types';
import { describeApiError, type ApiClient } from '../lib/api';

/**
 * Saved phrases.
 *
 * This closes a real gap: the API, the server store and `features.vocabulary`
 * all advertised saved phrases, but nothing in the UI could reach them, so the
 * three client methods were dead code. An advertised feature with no control is
 * exactly the "fake functionality" the spec forbids.
 *
 * Purpose is learning, not note-taking: the user saves a sentence they struggled
 * to say, with the meaning that made it click.
 */

export function VocabularyPanel({
  api,
  draft,
  onDraftConsumed,
  enabled,
}: {
  api: ApiClient;
  /** Text handed over from the script panel ("save this sentence"). */
  draft: string | null;
  onDraftConsumed: () => void;
  /** Server capability flag; when false the panel says so instead of failing. */
  enabled: boolean;
}) {
  const [items, setItems] = useState<VocabularyItem[]>([]);
  const [term, setTerm] = useState('');
  const [meaningEn, setMeaningEn] = useState('');
  const [meaningHi, setMeaningHi] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  // Pull in a sentence from the script panel when the user asks to save it.
  useEffect(() => {
    if (draft === null) return;
    setTerm(draft.slice(0, 120));
    onDraftConsumed();
  }, [draft, onDraftConsumed]);

  const refresh = useCallback(async () => {
    try {
      const list = await api.listVocabulary();
      setItems(list);
      setError(null);
    } catch (err) {
      setError(describeApiError(err).message);
    } finally {
      setLoaded(true);
    }
  }, [api]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
  }, [enabled, refresh]);

  const add = async (): Promise<void> => {
    const cleanTerm = term.trim();
    const cleanMeaning = meaningEn.trim();
    if (cleanTerm.length === 0 || cleanMeaning.length === 0 || busy) return;

    setBusy(true);
    setError(null);
    try {
      const saved = await api.saveVocabulary({
        term: cleanTerm,
        meaningEn: cleanMeaning,
        meaningHi: meaningHi.trim().length > 0 ? meaningHi.trim() : null,
        example: null,
      });
      // Saving the same term replaces it server-side, so de-duplicate locally too.
      setItems((current) => [saved, ...current.filter((item) => item.id !== saved.id && item.term.toLowerCase() !== saved.term.toLowerCase())]);
      setTerm('');
      setMeaningEn('');
      setMeaningHi('');
    } catch (err) {
      setError(describeApiError(err).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string): Promise<void> => {
    try {
      await api.deleteVocabulary(id);
      setItems((current) => current.filter((item) => item.id !== id));
    } catch (err) {
      setError(describeApiError(err).message);
    }
  };

  return (
    <section className="panel" aria-labelledby="vocab-title">
      <div className="panel-head">
        <span className="panel-title" id="vocab-title">
          <span className="glyph">✎</span> Saved phrases
        </span>
        <span className="text-[11px] text-ink-3">{items.length} saved</span>
      </div>

      <div className="p-4 flex flex-col gap-3">
        {!enabled ? (
          <p className="notice notice-info" role="status">
            Saved phrases are not available on this server. The feature is enabled by default; if you
            see this, the server rejected the request or the feature flag is off.
          </p>
        ) : null}

        <div className="flex flex-col gap-2">
          <div>
            <label className="field-label" htmlFor="vocab-term">
              English sentence
            </label>
            <input
              id="vocab-term"
              className="field"
              maxLength={120}
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              placeholder="I'll investigate and update you once I have more information."
            />
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <div>
              <label className="field-label" htmlFor="vocab-en">
                What it means
              </label>
              <input
                id="vocab-en"
                className="field"
                maxLength={400}
                value={meaningEn}
                onChange={(event) => setMeaningEn(event.target.value)}
                placeholder="Safe way to buy time without promising a fix."
              />
            </div>
            <div>
              <label className="field-label" htmlFor="vocab-hi">
                Hindi meaning (optional)
              </label>
              <input
                id="vocab-hi"
                className="field"
                maxLength={400}
                value={meaningHi}
                onChange={(event) => setMeaningHi(event.target.value)}
                placeholder="मैं जाँच करके बताऊँगा।"
              />
            </div>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm self-start"
            onClick={() => void add()}
            disabled={!enabled || busy || term.trim().length === 0 || meaningEn.trim().length === 0}
          >
            {busy ? 'Saving…' : 'Save phrase'}
          </button>
        </div>

        {error === null ? null : (
          <p className="notice notice-error" role="alert">
            {error}
          </p>
        )}

        {!loaded ? (
          <p className="text-xs text-ink-3">Loading saved phrases…</p>
        ) : items.length === 0 ? (
          <p className="text-xs text-ink-3 leading-relaxed">
            Nothing saved yet. When a reply helps you, press <strong className="text-ink-2">Save
            phrase</strong> on the script to keep it here for practice.
          </p>
        ) : (
          <ul className="flex flex-col gap-2 list-none p-0 m-0">
            {items.map((item) => (
              <li key={item.id} className="panel-quiet px-3 py-2.5 flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-[13.5px] font-semibold leading-snug break-words">{item.term}</p>
                  <p className="text-[12.5px] text-ink-2 leading-relaxed mt-0.5">{item.meaningEn}</p>
                  {item.meaningHi === null ? null : (
                    <p className="text-[12.5px] text-ink-2 leading-relaxed mt-0.5" lang="hi">
                      {item.meaningHi}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => void remove(item.id)}
                  aria-label={`Delete phrase: ${item.term}`}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

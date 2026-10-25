import { useState } from 'react';
import type { AppConfig, ReplyIntent, ReplyTone } from '../../shared/types';
import { isBrowserSpeechSupported, isTabAudioSupported } from '../audio/audioSource';
import { REPLY_INTENT_LABELS, type UserSettings } from '../lib/settings';

interface SettingsDrawerProps {
  open: boolean;
  onClose: () => void;
  settings: UserSettings;
  onSave: (settings: UserSettings) => void;
  config: AppConfig | null;
  onClearTranscript: () => void;
}

const TONES: Array<{ value: ReplyTone; label: string }> = [
  { value: 'professional', label: 'Professional' },
  { value: 'friendly', label: 'Friendly' },
  { value: 'concise', label: 'Concise' },
  { value: 'confident', label: 'Confident' },
  { value: 'diplomatic', label: 'Diplomatic' },
  { value: 'empathetic', label: 'Empathetic' },
];

export function SettingsDrawer({
  open,
  onClose,
  settings,
  onSave,
  config,
  onClearTranscript,
}: SettingsDrawerProps) {
  const [draft, setDraft] = useState<UserSettings>(settings);
  const [saved, setSaved] = useState(false);

  if (!open) return null;

  const update = <K extends keyof UserSettings>(key: K, value: UserSettings[K]): void => {
    setDraft((current) => ({ ...current, [key]: value }));
    setSaved(false);
  };

  const commit = (): void => {
    onSave(draft);
    setSaved(true);
  };

  const tabSupported = isTabAudioSupported();
  const speechSupported = isBrowserSpeechSupported();

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Settings">
        <div className="panel-head">
          <span className="panel-title">
            <span className="glyph">◆</span> Settings
          </span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="flex-1 overflow-y-auto transcript-scroll px-5 py-5 flex flex-col gap-6">
          <section>
            <h3 className="text-[13px] font-bold tracking-[0.08em] uppercase text-ink-3 mb-2">
              Transcription source
            </h3>
            <div className="flex flex-col gap-2">
              {(
                [
                  {
                    id: 'openai-realtime' as const,
                    title: 'OpenAI streaming (recommended)',
                    body: 'Real-time transcription over WebRTC. Needs OPENAI_API_KEY on the server and a Chrome-based browser for tab audio.',
                    available: config?.realtimeConfigured ?? false,
                  },
                  {
                    id: 'chunked-stt' as const,
                    title: 'Chunked speech-to-text (free tier)',
                    body: config?.sttMode === 'chunked'
                      ? 'Posts short audio chunks to a free-tier recogniser. Text arrives every 1.5-3 s instead of word by word, so there are no live partials and the preliminary reply only fires once text exists.'
                      : 'Needs STT_PROVIDER=openai-compatible and STT_API_KEY on the server. See docs/STT_PROVIDERS.md.',
                    available: config?.sttMode === 'chunked',
                  },
                  {
                    id: 'extension-bridge' as const,
                    title: 'Chrome extension (tab audio)',
                    body: 'Recommended for meetings. The SpeakFlow extension captures the meeting tab and keeps it audible. Start capture from the extension popup on that tab first.',
                    available: true,
                  },
                  {
                    id: 'browser-speech' as const,
                    title: 'Browser speech',
                    body: 'Built-in recogniser. Microphone only. Audio goes to your browser vendor, not to SpeakFlow.',
                    available: speechSupported,
                  },
                  {
                    id: 'simulated' as const,
                    title: 'Demo transcript (simulation)',
                    body: 'Replays a scripted conversation. No audio is captured. Use it to see provisional and refined replies.',
                    available: true,
                  },
                ]
              ).map((option) => (
                <label
                  key={option.id}
                  className={`panel-quiet p-3 cursor-pointer transition-colors ${
                    draft.provider === option.id ? 'border-accent/60' : ''
                  } ${option.available ? '' : 'opacity-60'}`}
                >
                  <span className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="provider"
                      checked={draft.provider === option.id}
                      onChange={() => update('provider', option.id)}
                      className="accent-[var(--color-accent)]"
                    />
                    <span className="text-sm font-semibold">{option.title}</span>
                    {option.available ? null : (
                      <span className="badge badge-neutral">unavailable</span>
                    )}
                  </span>
                  <span className="block text-xs text-ink-3 mt-1 pl-6 leading-relaxed">{option.body}</span>
                </label>
              ))}
            </div>
          </section>

          <section>
            <h3 className="text-[13px] font-bold tracking-[0.08em] uppercase text-ink-3 mb-2">
              Audio source
            </h3>
            <div className="segmented w-full">
              <button
                type="button"
                aria-pressed={draft.captureMode === 'tab'}
                onClick={() => update('captureMode', 'tab')}
                className="flex-1"
                disabled={!tabSupported}
              >
                Browser tab
              </button>
              <button
                type="button"
                aria-pressed={draft.captureMode === 'system'}
                onClick={() => update('captureMode', 'system')}
                className="flex-1"
                disabled={!tabSupported}
              >
                Screen + system audio
              </button>
              <button
                type="button"
                aria-pressed={draft.captureMode === 'microphone'}
                onClick={() => update('captureMode', 'microphone')}
                className="flex-1"
              >
                Microphone
              </button>
            </div>
            {tabSupported ? null : (
              <p className="text-xs text-ink-3 mt-2 leading-relaxed">
                Tab audio capture is unavailable in this browser. Use desktop Chrome or Edge, or switch to
                the microphone.
              </p>
            )}
          </section>

          <section>
            <h3 className="text-[13px] font-bold tracking-[0.08em] uppercase text-ink-3 mb-2">
              Reply tone
            </h3>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Reply tone">
              {TONES.map((tone) => (
                <button
                  key={tone.value}
                  type="button"
                  aria-pressed={draft.tone === tone.value}
                  onClick={() => update('tone', tone.value)}
                  className={`btn btn-sm ${draft.tone === tone.value ? 'btn-primary' : 'btn-ghost'}`}
                >
                  {tone.label}
                </button>
              ))}
            </div>
          </section>

          <section>
            <label className="field-label" htmlFor="reply-intent">
              Default response intent
            </label>
            <select
              id="reply-intent"
              className="field"
              value={draft.replyIntent ?? ''}
              onChange={(event) =>
                update('replyIntent', event.target.value === '' ? null : (event.target.value as ReplyIntent))
              }
            >
              <option value="">Let the AI decide</option>
              {Object.entries(REPLY_INTENT_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-ink-3 mt-1.5 leading-relaxed">
              Pins what your reply is trying to do. &ldquo;Let the AI decide&rdquo; reads the client&rsquo;s
              question and picks one.
            </p>
          </section>

          <section>
            <label className="field-label" htmlFor="user-context">
              Context about your work
            </label>
            <textarea
              id="user-context"
              className="field"
              rows={3}
              maxLength={1000}
              value={draft.userContext}
              onChange={(event) => update('userContext', event.target.value)}
              placeholder="e.g. I'm the backend developer on the payments module. Sprint ends Friday."
            />
            <p className="text-xs text-ink-3 mt-1.5 leading-relaxed">
              Sent with every reply request so the AI does not have to guess your role. This is background,
              not proof of project status.
            </p>
          </section>

          <section>
            <label className="field-label" htmlFor="access-token">
              Workspace access token {config?.authRequired === true ? '(required)' : '(optional)'}
            </label>
            <input
              id="access-token"
              type="password"
              className="field"
              value={draft.accessToken}
              onChange={(event) => update('accessToken', event.target.value)}
              placeholder={config?.authRequired === true ? 'Required by this server' : 'Not required by this server'}
              autoComplete="off"
            />
            <p className="text-xs text-ink-3 mt-1.5 leading-relaxed">
              Stored only in this browser. It is a shared workspace secret, not a personal account.
            </p>
          </section>

          <section className="border-t border-line pt-4">
            <h3 className="text-[13px] font-bold tracking-[0.08em] uppercase text-ink-3 mb-2">Privacy</h3>
            <p className="text-xs text-ink-2 leading-relaxed">
              Audio streams straight to the transcription provider and is never written to disk by
              SpeakFlow. Transcripts live in this tab's memory only, and are cleared when you stop or
              reload. Only saved phrases persist, and only if the server enables it.
            </p>
            <button type="button" className="btn btn-ghost btn-sm mt-3" onClick={onClearTranscript}>
              Clear this transcript now
            </button>
          </section>
        </div>

        <div className="p-4 border-t border-line flex items-center justify-between gap-3">
          <span className="text-xs text-ink-3">{saved ? 'Saved.' : 'Changes apply to new replies.'}</span>
          <button type="button" className="btn btn-primary" onClick={commit}>
            Save settings
          </button>
        </div>
      </aside>
    </>
  );
}

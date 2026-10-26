import { useEffect, useMemo, useRef, useState } from 'react';
import type { LatencyMarks, PipelineStage, RefineDirective, ReplyResult, ReplyTone, SessionStatus } from '../shared/types';
import { SettingsDrawer } from './components/SettingsDrawer';
import { PermissionExplainer } from './components/PermissionExplainer';
import { VocabularyPanel } from './components/VocabularyPanel';
import { TranslatorPanel } from './components/TranslatorPanel';
import { useCopilotSession } from './hooks/useCopilotSession';
import { ApiClient } from './lib/api';
import { getClientId, loadSettings, saveSettings, REFINE_LABELS, type UserSettings } from './lib/settings';

/**
 * SpeakFlow AI workspace.
 *
 * Layout intent: the script is the loudest thing on screen, because that is the
 * only element the user needs while someone is talking to them. Transcript and
 * metrics are deliberately quieter.
 */

const STATUS_LABEL: Record<SessionStatus, string> = {
  idle: 'Ready',
  'requesting-permission': 'Requesting permission',
  connecting: 'Connecting',
  listening: 'Listening',
  reconnecting: 'Reconnecting',
  paused: 'Paused',
  stopped: 'Stopped',
  error: 'Needs attention',
};

/** prompt 2 §6: name the live pipeline stage instead of showing a bare spinner. */
const PIPELINE_LABEL: Record<PipelineStage, string> = {
  idle: 'Idle',
  connecting: 'Connecting',
  listening: 'Listening',
  transcribing: 'Transcribing',
  generating: 'Preparing suggestion',
  refining: 'Refining reply',
  unavailable: 'Capture unavailable',
};

const TONE_OPTIONS: Array<{ value: ReplyTone; label: string }> = [
  { value: 'professional', label: 'Professional' },
  { value: 'friendly', label: 'Friendly' },
  { value: 'concise', label: 'Concise' },
  { value: 'confident', label: 'Confident' },
  { value: 'diplomatic', label: 'Diplomatic' },
  { value: 'empathetic', label: 'Empathetic' },
];

const REFINE_OPTIONS: RefineDirective[] = ['simpler', 'shorter', 'natural', 'formal'];

function formatClock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function LatencyStrip({ latency }: { latency: LatencyMarks }) {
  const metrics: Array<{ label: string; value: number | null; hero?: boolean }> = [
    { label: 'Speech → reply', value: latency.speechToReplyMs, hero: true },
    { label: 'Speech → text', value: latency.speechToTranscriptMs },
    { label: 'Text → request', value: latency.transcriptToRequestMs },
    { label: 'Request → reply', value: latency.requestToReplyMs },
  ];

  return (
    <div className="flex items-center gap-5 flex-wrap" aria-label="Measured latency">
      {metrics.map((metric) => (
        <div className="metric" key={metric.label}>
          <span className={`metric-value ${metric.hero ? 'text-accent' : ''}`}>
            {metric.value === null ? '—' : `${metric.value} ms`}
          </span>
          <span className="metric-label">{metric.label}</span>
        </div>
      ))}
    </div>
  );
}

function ScriptPanel({
  reply,
  pending,
  discarded,
  onRegenerate,
  canRegenerate,
  onSavePhrase,
  tone,
  onTone,
  onRefine,
}: {
  reply: ReplyResult | null;
  pending: boolean;
  discarded: number;
  onRegenerate: () => void;
  canRegenerate: boolean;
  onSavePhrase: (text: string) => void;
  tone: ReplyTone;
  onTone: (tone: ReplyTone) => void;
  onRefine: (directive: RefineDirective) => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async (key: string, value: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      window.setTimeout(() => setCopied(null), 1800);
    } catch {
      setCopied(null);
    }
  };

  const stage = reply?.stage ?? null;
  // Labels are fixed by prompt 2 §2/§6 and must match exactly.
  const badge =
    stage === 'provisional'
      ? { className: 'badge badge-provisional', text: 'Live suggestion · still listening' }
      : stage === 'refined'
        ? { className: 'badge badge-ready', text: 'Suggested reply' }
        : { className: 'badge badge-neutral', text: 'Waiting for speech' };

  return (
    <section className="flex flex-col gap-4" aria-labelledby="script-heading">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2.5">
          <h2 id="script-heading" className="text-[12px] font-bold tracking-[0.1em] uppercase text-ink-3">
            Your script
          </h2>
          <span className={badge.className} data-testid="script-stage" data-stage={stage ?? 'none'}>
            {stage === 'refined' ? <span className="dot" /> : null}
            {badge.text}
          </span>
          {reply?.engine === 'mock' ? <span className="badge badge-mock">Mock AI</span> : null}
          {reply?.engine === 'local_library' ? (
            <span className="badge badge-neutral" title="Matched a hand-written template. No AI request was made.">
              From library
            </span>
          ) : null}
          {reply?.engine === 'safe_fallback' ? <span className="badge badge-alert">Fallback</span> : null}
          {reply?.needsClarification === true ? (
            <span className="badge badge-neutral">Clarify</span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {discarded > 0 ? (
            <span className="text-[11px] text-ink-3" title="Older AI replies were discarded to keep this one">
              {discarded} older reply dropped
            </span>
          ) : null}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onRegenerate}
            disabled={!canRegenerate || pending}
          >
            {pending ? 'Thinking…' : 'Regenerate'}
          </button>
          <button
            type="button"
            className="btn btn-ready btn-sm"
            onClick={() => reply !== null && void copy('main', reply.suggestedReply)}
            disabled={reply === null}
          >
            {copied === 'main' ? 'Copied' : 'Copy script'}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => reply !== null && onSavePhrase(reply.suggestedReply)}
            disabled={reply === null}
            title="Keep this sentence in Saved phrases for practice"
          >
            Save to phrases
          </button>
        </div>
      </div>

      <div
        className="script-card"
        data-stage={stage ?? 'none'}
        data-pending={pending ? 'true' : 'false'}
        aria-live="polite"
        aria-atomic="true"
      >
        <div className="px-5 py-5 sm:px-6 sm:py-6">
          {reply === null ? (
            <p className="script-placeholder">
              {pending
                ? 'Listening for enough context…'
                : 'Start live assistance. As soon as the client says enough for a safe reply, the script appears here.'}
            </p>
          ) : (
            <p className="script-text" data-stage={reply.stage}>
              {reply.suggestedReply}
            </p>
          )}

          {reply?.notice === null || reply === null ? null : (
            <p className="notice notice-warn mt-4" role="status">
              {reply.notice}
            </p>
          )}
        </div>

        {reply === null ? null : (
          <>
            <hr className="hairline" />
            <div className="px-5 py-4 sm:px-6 flex flex-col gap-4">
              {reply.alternativeReply === null ? null : (
                <div>
                  <span className="field-label">Or say it this way</span>
                  <p className="text-[15px] leading-relaxed text-ink-2">{reply.alternativeReply}</p>
                </div>
              )}

              {reply.factsToVerify.length > 0 ? (
                <div>
                  <span className="field-label">Verify before you state as fact</span>
                  <ul className="flex flex-col gap-1 list-none p-0 m-0">
                    {reply.factsToVerify.map((fact) => (
                      <li key={fact} className="text-[13px] text-ink-2 flex gap-2">
                        <span className="text-accent">·</span>
                        {fact}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div className="flex items-center gap-3 flex-wrap text-[11px] text-ink-3 mono">
                <span>v{reply.version}</span>
                <span>{reply.intent}</span>
                <span>confidence {reply.confidence}</span>
                <span>{reply.model}</span>
                <span>{reply.latencyMs} ms server</span>
              </div>
            </div>
          </>
        )}

        {/* Tone and rewrite stay on screen: a wrong-sounding script is fixed here,
            not in a settings dialog, while the client is still waiting. */}
        <hr className="hairline" />
        <div className="px-5 py-3 sm:px-6 flex flex-col gap-2.5">
          <div className="flex items-center gap-1.5 flex-wrap" role="group" aria-label="Reply tone">
            <span className="field-label mr-1">Tone</span>
            {TONE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`btn btn-sm ${tone === option.value ? 'btn-primary' : 'btn-ghost'}`}
                aria-pressed={tone === option.value}
                onClick={() => onTone(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1.5 flex-wrap" role="group" aria-label="Rewrite the script">
            <span className="field-label mr-1">Rewrite</span>
            {REFINE_OPTIONS.map((directive) => (
              <button
                key={directive}
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => onRefine(directive)}
                disabled={reply === null || pending}
              >
                {REFINE_LABELS[directive]}
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function TranscriptPanel({
  segments,
  partial,
  status,
  onClear,
}: {
  segments: Array<{ id: string; text: string; final: boolean; startedAt: number }>;
  partial: string;
  status: SessionStatus;
  onClear: () => void;
}) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  // Keep the newest speech visible without the user touching the scrollbar.
  useEffect(() => {
    const node = scrollerRef.current;
    if (node === null) return;
    node.scrollTop = node.scrollHeight;
  }, [segments.length, partial]);

  const listening = status === 'listening';

  return (
    <section className="panel flex flex-col min-h-0" aria-labelledby="transcript-heading">
      <div className="panel-head">
        <span className="panel-title" id="transcript-heading">
          <span className="glyph">◉</span> Client transcript
        </span>
        <div className="flex items-center gap-2">
          {listening ? <span className="dot dot-live" aria-hidden="true" /> : null}
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClear} disabled={segments.length === 0}>
            Clear
          </button>
        </div>
      </div>

      <div className="transcript-scroll flex-1 min-h-[180px] max-h-[46vh] px-3 py-3 flex flex-col gap-2" ref={scrollerRef}>
        {segments.length === 0 && partial.length === 0 ? (
          <div className="px-2 py-6 text-center">
            <p className="text-sm text-ink-2">Nothing captured yet.</p>
            <p className="text-xs text-ink-3 mt-1.5 leading-relaxed max-w-[34ch] mx-auto">
              Start live assistance and have the client speak. Provisional text appears in copper,
              finalized text is solid.
            </p>
          </div>
        ) : null}

        {segments.map((segment) => (
          <div key={segment.id} className="segment segment-final">
            <div className="flex items-baseline gap-2">
              <span className="segment-time">{formatClock(segment.startedAt - (segments[0]?.startedAt ?? segment.startedAt))}</span>
              <p className="text-[14.5px] leading-relaxed flex-1">{segment.text}</p>
            </div>
          </div>
        ))}

        {partial.length > 0 ? (
          <div className="segment segment-partial">
            <div className="flex items-baseline gap-2">
              <span className="segment-time">now</span>
              <p className="text-[14.5px] leading-relaxed flex-1 caret">{partial}</p>
            </div>
          </div>
        ) : null}
      </div>

      <div className="px-4 py-2 border-t border-line flex items-center justify-between text-[11px] text-ink-3">
        <span>{segments.length} finalized</span>
        <span>Kept in this tab only</span>
      </div>
    </section>
  );
}

export default function App() {
  const [settings, setSettings] = useState<UserSettings>(() => loadSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [copiedNotice, setCopiedNotice] = useState(false);
  const [phraseDraft, setPhraseDraft] = useState<string | null>(null);

  const clientId = useMemo(() => getClientId(), []);
  // Split deployment (SPA on Vercel, API on Render) needs an absolute API base;
  // same-origin deployments fall back to '/api'. `?? '/api'` is not enough: an
  // empty `VITE_API_BASE_URL=` (the value `.env` ships with) is defined, so it
  // would become '' and every request would drop the `/api` prefix - `/config`
  // instead of `/api/config`, i.e. a 404 from the SPA's own static handler.
  const configuredApiBase = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim() ?? '';
  const apiBaseUrl = configuredApiBase.replace(/\/+$/, '') || '/api';
  const api = useMemo(
    () =>
      new ApiClient({
        baseUrl: apiBaseUrl,
        clientId,
        accessToken: settings.accessToken.trim().length > 0 ? settings.accessToken.trim() : null,
      }),
    [apiBaseUrl, clientId, settings.accessToken],
  );

  const session = useCopilotSession({ api, settings });

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  const startDisabled =
    session.status === 'requesting-permission' ||
    session.status === 'connecting' ||
    session.status === 'reconnecting' ||
    session.status === 'listening';

  const providerName = session.activeProviderLabel ?? 'not started';

  return (
    <div className="relative z-10 min-h-full flex flex-col">
      <header className="border-b border-line/80 backdrop-blur-sm sticky top-0 z-20 bg-canvas/85">
        <div className="mx-auto max-w-[1320px] px-5 lg:px-8 py-3 flex items-center gap-4">
          <div className="flex items-baseline gap-2.5">
            <span className="font-display text-[22px] leading-none tracking-tight">SpeakFlow</span>
            <span className="badge badge-provisional">AI</span>
          </div>

          <span className="hidden md:block text-[11px] text-ink-3 tracking-[0.14em] uppercase">
            Live call copilot
          </span>

          <div className="ml-auto flex items-center gap-2.5">
            <span
              className={`badge ${
                session.status === 'listening'
                  ? 'badge-ready'
                  : session.status === 'error'
                    ? 'badge-alert'
                    : session.status === 'paused'
                      ? 'badge-provisional'
                      : 'badge-neutral'
              }`}
            >
              {session.status === 'listening' ? <span className="dot dot-live" /> : null}
              {session.status === 'reconnecting' ? <span className="dot dot-warn" /> : null}
              {STATUS_LABEL[session.status]}
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setSettingsOpen(true)}
              aria-label="Open settings"
            >
              Settings
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1320px] px-5 lg:px-8 py-6 flex flex-col gap-5 flex-1">
        {session.configError === null ? null : (
          <div className="notice notice-error" role="alert">
            <span>
              <strong>Server unreachable.</strong> {session.configError} Run <code>npm run dev</code> or check
              the API URL.
            </span>
          </div>
        )}

        {session.configNotice === null ? null : (
          <div className="notice notice-info" role="status">
            <span className="flex-1">{session.configNotice}</span>
            <button type="button" className="link text-xs" onClick={session.dismissConfigNotice}>
              Dismiss
            </button>
          </div>
        )}

        {session.error === null ? null : (
          <div className="notice notice-error" role="alert">
            <span>
              <strong>{session.error.message}</strong>
              {session.error.hint === undefined ? null : <> {session.error.hint}</>}
            </span>
          </div>
        )}

        {session.requestError === null ? null : (
          <div className="notice notice-warn" role="alert">
            <span>{session.requestError.message}</span>
          </div>
        )}

        {/* ---------------------------------------------------------- controls */}
        <section className="panel px-4 py-3.5 sm:px-5 flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void session.start()}
              disabled={startDisabled}
            >
              {session.status === 'idle' || session.status === 'stopped' || session.status === 'error'
                ? 'Start live assistance'
                : session.status === 'paused'
                  ? 'Resume'
                  : 'Starting…'}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => (session.status === 'paused' ? void session.resume() : session.pause())}
              disabled={!session.isActive && session.status !== 'paused'}
            >
              {session.status === 'paused' ? 'Resume' : 'Pause'}
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={session.stop}
              disabled={session.status === 'idle' || session.status === 'stopped'}
            >
              Stop
            </button>
          </div>

          <div className="flex items-center gap-4 ml-auto flex-wrap">
            <div className="flex items-center gap-2">
              <div className="level-meter" aria-hidden="true">
                {Array.from({ length: 12 }).map((_, index) => {
                  const threshold = (index + 1) / 12;
                  const active = session.level >= threshold;
                  return (
                    <span
                      key={index}
                      className="level-bar"
                      style={{
                        height: `${5 + index * 1.1}px`,
                        backgroundColor: active ? 'var(--color-ready)' : 'var(--color-line-strong)',
                      }}
                    />
                  );
                })}
              </div>
              <span className="text-[11px] text-ink-3">input</span>
            </div>
            <span className="text-[11px] text-ink-3">
              <span className="text-ink-2">{providerName}</span> ·{' '}
              {settings.provider === 'extension-bridge'
                ? 'extension tab audio'
                : settings.captureMode === 'tab'
                  ? 'tab audio'
                  : settings.captureMode === 'system'
                    ? 'system audio (desktop apps)'
                    : 'microphone'}
            </span>
            <span
              className={`badge ${
                session.pipelineStage === 'unavailable'
                  ? 'badge-alert'
                  : session.pipelineStage === 'generating' || session.pipelineStage === 'refining'
                    ? 'badge-provisional'
                    : 'badge-neutral'
              }`}
              data-testid="pipeline-stage"
              data-stage={session.pipelineStage}
              aria-live="polite"
            >
              {PIPELINE_LABEL[session.pipelineStage]}
            </span>
          </div>
        </section>

        {session.statusDetail === null ? null : (
          <p className="text-xs text-ink-3 -mt-2">{session.statusDetail}</p>
        )}

        {/* prompt 2 §4: a known audio gap must be admitted, never smoothed over. */}
        {session.contextUncertain ? (
          <div className="notice notice-warn" role="status" data-testid="context-uncertain">
            <span>
              <strong>Part of the audio was lost.</strong> The transcript has a gap, so a reply may be
              based on incomplete context. Treat the current suggestion with extra care, and ask the
              other person to repeat anything important.
            </span>
          </div>
        ) : null}

        {/* Onboarding: explain permissions before any prompt appears (spec §3). */}
        {session.status === 'idle' || session.status === 'stopped' || session.status === 'error' ? (
          <PermissionExplainer
            provider={settings.provider}
            captureMode={settings.captureMode}
            onStart={() => void session.start()}
          />
        ) : null}

        {/* ------------------------------------------------------------- live */}
        <div className="grid gap-5 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] items-start">
          <TranscriptPanel
            segments={session.segments}
            partial={session.partial}
            status={session.status}
            onClear={session.clearTranscript}
          />

          <div className="panel px-4 py-4 sm:px-5 sm:py-5 flex flex-col gap-5">
            <ScriptPanel
              reply={session.reply}
              pending={session.replyPending}
              discarded={session.discardedStale}
              onRegenerate={() => void session.regenerate()}
              canRegenerate={session.reply !== null || session.partial.length > 0 || session.segments.length > 0}
              tone={settings.tone}
              onTone={(tone) => {
                setSettings((current) => ({ ...current, tone }));
                // Re-run now so the change applies to the script on screen
                // instead of silently waiting for new speech.
                void session.applyTone(tone);
              }}
              onRefine={(directive) => void session.refine(directive)}
              onSavePhrase={(text) => {
                setPhraseDraft(text);
                // Move the user to the panel their action just filled in.
                document.getElementById('vocab-term')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
              }}
            />

            <hr className="hairline" />
            <LatencyStrip latency={session.latency} />
          </div>
        </div>

        {/* ------------------------------------------------------- translator */}
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] items-start">
          <TranslatorPanel api={api} tone={settings.tone} />

          <section className="panel-quiet px-4 py-4 sm:px-5 flex flex-col gap-3">
            <span className="panel-title">
              <span className="glyph">◦</span> Before you speak
            </span>
            <ul className="flex flex-col gap-2.5 list-none p-0 m-0 text-[13px] text-ink-2 leading-relaxed">
              <li>
                <strong className="text-ink">Live suggestion · still listening</strong> appears while the
                client is still talking - it is a safe opener, not an answer.
              </li>
              <li>
                <strong className="text-ink">Suggested reply</strong> replaces it when the thought finishes
                and has been re-read against the recent conversation.
              </li>
              <li>
                Anything under <strong className="text-ink">Verify before you state as fact</strong> is
                unknown to the AI. Check it before you say it.
              </li>
              <li>
                <button
                  type="button"
                  className="link"
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(JSON.stringify(session.reply, null, 2))
                      .then(() => {
                        setCopiedNotice(true);
                        window.setTimeout(() => setCopiedNotice(false), 1800);
                      })
                      .catch(() => undefined);
                  }}
                  disabled={session.reply === null}
                >
                  {copiedNotice ? 'Copied reply details' : 'Copy reply details'}
                </button>{' '}
                to share a bug report - it contains no audio.
              </li>
            </ul>
            <p className="text-[11px] text-ink-3 leading-relaxed border-t border-line pt-3">
              SpeakFlow never records calls or stores transcripts on the server. Capture is always visible
              and can be stopped at any time.
            </p>
          </section>
        </div>

        <VocabularyPanel
          api={api}
          draft={phraseDraft}
          onDraftConsumed={() => setPhraseDraft(null)}
          enabled={session.config === null ? null : session.config.features.vocabulary}
        />
      </main>

      <footer className="border-t border-line mt-2">
        <div className="mx-auto max-w-[1320px] px-5 lg:px-8 py-3 flex items-center gap-3 flex-wrap text-[11px] text-ink-3">
          <span>
            Provider: {session.config?.mockAi === true ? 'mock AI (labelled)' : session.config?.aiConfigured === true ? 'configured' : 'not configured'}
          </span>
          <span aria-hidden="true">·</span>
          <span>Transcription: {session.config?.realtimeConfigured === true ? session.config.transcribeModel : 'not configured'}</span>
          <span aria-hidden="true">·</span>
          <span>v{session.config?.version ?? '1.0.0'}</span>
          {session.config?.authRequired === true ? (
            <>
              <span aria-hidden="true">·</span>
              <span>workspace lock on</span>
            </>
          ) : null}
        </div>
      </footer>

      <SettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onSave={setSettings}
        config={session.config}
        onClearTranscript={session.clearTranscript}
      />
    </div>
  );
}

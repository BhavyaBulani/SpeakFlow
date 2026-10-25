import { useEffect, useState } from 'react';
import type { AudioCaptureMode, TranscriptionProviderId } from '../../shared/types';
import {
  capabilityStateLabel,
  detectCapabilities,
  explainerItems,
  watchCapabilities,
  type CapabilityStatus,
  type PermissionSnapshot,
} from '../lib/permissions';

/**
 * Explains each permission *before* the browser prompt appears, and shows the
 * real current state afterwards.
 *
 * Spec §3 requires: why it is needed, what it accesses, how it is processed,
 * whether it reaches the cloud, how to stop it — plus explicit states and
 * recovery instructions when access is denied. Nothing here optimistically
 * reports "granted": every state comes from the browser or an honest unknown.
 */

const STATE_STYLE: Record<string, string> = {
  granted: 'badge badge-ready',
  denied: 'badge badge-alert',
  'not-requested': 'badge badge-neutral',
  restricted: 'badge badge-provisional',
  unsupported: 'badge badge-mock',
  unknown: 'badge badge-neutral',
};

function StateChip({ capability }: { capability: CapabilityStatus }) {
  return (
    <span className={STATE_STYLE[capability.state] ?? 'badge badge-neutral'}>
      {capability.label}: {capabilityStateLabel(capability.state)}
    </span>
  );
}

export function PermissionExplainer({
  provider,
  captureMode,
  onStart,
}: {
  provider: TranscriptionProviderId;
  captureMode: AudioCaptureMode;
  onStart: () => void;
}) {
  const [snapshot, setSnapshot] = useState<PermissionSnapshot | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const unsubscribe = watchCapabilities(setSnapshot);
    // Also refresh once on mount in browsers that do not emit change events.
    void detectCapabilities().then(setSnapshot);
    return unsubscribe;
  }, []);

  const items = explainerItems({
    provider,
    captureMode: captureMode === 'demo' ? 'demo' : captureMode,
  });

  const capabilities: CapabilityStatus[] =
    snapshot === null
      ? []
      : captureMode === 'microphone'
        ? [snapshot.microphone]
        : [snapshot.tabAudio];
  const denied = capabilities.some((capability) => capability.state === 'denied');
  const unsupported = capabilities.some((capability) => capability.state === 'unsupported');

  return (
    <section
      className="panel-quiet px-4 py-4 sm:px-5 flex flex-col gap-3"
      aria-labelledby="permission-explainer-title"
    >
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex flex-col gap-1">
          <span className="panel-title" id="permission-explainer-title">
            <span className="glyph">⚿</span> Before you allow audio
          </span>
          <p className="text-[13px] text-ink-2 leading-relaxed max-w-[62ch]">
            SpeakFlow only listens while you press Start, and the browser always shows its own
            capture indicator. Here is exactly what will be requested and why.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          {open ? 'Hide details' : 'Show details'}
        </button>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {capabilities.length === 0 ? (
          <span className="badge badge-neutral">Checking permission state…</span>
        ) : (
          capabilities.map((capability) => <StateChip key={capability.id} capability={capability} />)
        )}
        <span className="text-[11px] text-ink-3">
          Consent is your responsibility — check your workplace policy and local law before recording
          or transcribing a call.
        </span>
      </div>

      {denied ? (
        <div className="notice notice-error" role="alert">
          <span>
            <strong>Access is blocked.</strong>{' '}
            {capabilities.find((capability) => capability.state === 'denied')?.detail}
          </span>
        </div>
      ) : null}

      {unsupported ? (
        <div className="notice notice-warn" role="alert">
          <span>
            <strong>Not supported here.</strong>{' '}
            {capabilities.find((capability) => capability.state === 'unsupported')?.detail}
          </span>
        </div>
      ) : null}

      {open ? (
        <dl className="flex flex-col gap-3 m-0">
          {items.map((item) => (
            <div key={item.question}>
              <dt className="field-label">{item.question}</dt>
              <dd className="m-0 text-[13.5px] text-ink-2 leading-relaxed">{item.answer}</dd>
            </div>
          ))}
          <div>
            <dt className="field-label">Does SpeakFlow store anything?</dt>
            <dd className="m-0 text-[13.5px] text-ink-2 leading-relaxed">
              No audio is ever written to disk, and the transcript lives only in this tab. Nothing is
              saved on the server, and closing the tab clears it.
            </dd>
          </div>
        </dl>
      ) : null}

      {provider === 'simulated' ? null : (
        <button type="button" className="btn btn-ghost btn-sm self-start" onClick={onStart}>
          Continue and allow
        </button>
      )}
    </section>
  );
}

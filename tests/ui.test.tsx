// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import App from '../src/client/App';

/**
 * Renders the real application component tree in jsdom.
 *
 * This exists because a served bundle returning HTTP 200 is NOT proof the UI
 * works: the app can boot, fetch nothing, throw during mount, and leave an empty
 * #root. These tests assert what a user would actually see.
 */

function mockConfig(overrides: Record<string, unknown> = {}) {
  return {
    version: '1.0.0',
    environment: 'test',
    aiConfigured: true,
    mockAi: true,
    realtimeConfigured: false,
    authRequired: false,
    replyProvider: 'openai',
    replyModel: 'gpt-4o-mini',
    aiJsonMode: 'json_schema',
    aiDailyRequestBudget: 200,
    transcribeModel: 'gpt-4o-transcribe',
    transcribeLanguage: 'en',
    maxTranscriptChars: 4000,
    contextWindowTurns: 6,
    sessionTtlMinutes: 120,
    features: { vocabulary: true, vocabularyPersistence: false },
    ...overrides,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/config')) {
        return new Response(JSON.stringify(mockConfig()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'no' } }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('workspace UI', () => {
  it('mounts and shows the live workspace (regression: empty #root)', () => {
    render(<App />);

    // The four things a user must be able to find immediately.
    expect(screen.getByRole('button', { name: /start live assistance/i })).toBeTruthy();
    expect(screen.getByText(/your script/i)).toBeTruthy();
    expect(screen.getByText(/say it in english/i)).toBeTruthy();
    expect(screen.getByText(/client transcript/i)).toBeTruthy();
  });

  it('shows an empty script state instead of a fake reply', () => {
    render(<App />);
    // No quote-shaped placeholder answer may be presented before any speech.
    expect(screen.getByText(/start live assistance\. as soon as the client says enough/i)).toBeTruthy();
    expect(screen.queryByText(/i'll check what's causing/i)).toBeNull();
  });

  it('reports the idle connection state and the audio source honestly', () => {
    render(<App />);
    expect(screen.getByText('Ready')).toBeTruthy();
    // Nothing configured for streaming => footer must say so rather than "connected".
    expect(screen.getByText(/transcription: not configured/i)).toBeTruthy();
  });

  it('surfaces the provider-not-configured notice rather than failing silently', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify(mockConfig({ aiConfigured: false, mockAi: false })), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    render(<App />);
    const notice = await screen.findByText(/ai provider is not configured/i);
    expect(notice).toBeTruthy();
  });

  it('has accessible names on the primary controls', () => {
    render(<App />);
    expect(screen.getByRole('button', { name: /^pause$/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^stop$/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /open settings/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^translate$/i })).toBeTruthy();
  });

  it('disables copy/regenerate before any reply exists', () => {
    render(<App />);
    // A control that cannot act yet must be disabled, not silently do nothing.
    expect((screen.getByRole('button', { name: /copy script/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /regenerate/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('states the privacy position in the UI', () => {
    render(<App />);
    expect(screen.getByText(/never records calls or stores transcripts/i)).toBeTruthy();
    expect(screen.getByText(/kept in this tab only/i)).toBeTruthy();
  });

  it('explains permissions before any prompt appears (spec §3)', () => {
    render(<App />);
    expect(screen.getByText(/before you allow audio/i)).toBeTruthy();
    // The five required explanations must be reachable, not just promised.
    fireEvent.click(screen.getByRole('button', { name: /show details/i }));
    expect(screen.getByText(/why is it needed\?/i)).toBeTruthy();
    expect(screen.getByText(/what does it access\?/i)).toBeTruthy();
    expect(screen.getByText(/how is it processed\?/i)).toBeTruthy();
    expect(screen.getByText(/does it go to the cloud\?/i)).toBeTruthy();
    expect(screen.getByText(/how do i stop it\?/i)).toBeTruthy();
    expect(screen.getByText(/does speakflow store anything\?/i)).toBeTruthy();
  });

  it('never claims a permission state that the browser did not report', async () => {
    render(<App />);
    // jsdom has no navigator.permissions, so the honest answer is Unsupported/Unknown.
    const chip = await screen.findByText(/tab audio:/i);
    const label = chip.textContent ?? '';
    expect(label).not.toMatch(/granted/i);
  });

  it('exposes saved phrases, which the server advertises (no dead feature)', async () => {
    render(<App />);
    // The API and config flag both claim vocabulary support; a user must be able
    // to reach it, otherwise the feature is advertised but unreachable.
    expect(await screen.findByText(/saved phrases/i)).toBeTruthy();
    expect(screen.getByLabelText(/english sentence/i)).toBeTruthy();
    expect(screen.getByLabelText(/what it means/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /save phrase/i })).toBeTruthy();
  });

  it('disables Save phrase until both required fields are filled', async () => {
    render(<App />);
    const savePhrase = (await screen.findByRole('button', {
      name: /^save phrase$/i,
    })) as HTMLButtonElement;
    expect(savePhrase.disabled).toBe(true);

    // A term alone is not enough: the meaning is what makes the phrase learnable.
    fireEvent.change(screen.getByLabelText(/english sentence/i), {
      target: { value: "I'll investigate and update you." },
    });
    expect(savePhrase.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/what it means/i), {
      target: { value: 'Buying time without promising a fix.' },
    });
    expect(savePhrase.disabled).toBe(false);
  });
});

import { captureError } from '../../shared/errors';
import { DEMO_SCRIPT } from '../lib/demoConversation';
import type { ProviderContext, TranscriptionProvider } from './types';

/**
 * Replays a scripted conversation so the two-stage pipeline can be seen without
 * a real call or provider credentials.
 *
 * It is a simulation and says so: `consumesCapturedStream = false`, the UI shows
 * a "DEMO" badge, and the status detail explicitly states that no audio is
 * captured. It never pretends to be live transcription.
 */
export class SimulatedTranscriptionProvider implements TranscriptionProvider {
  readonly id = 'simulated' as const;
  readonly label = 'Demo transcript';
  readonly note =
    'Replays a scripted conversation so you can try the provisional/refined pipeline. No audio is captured and nothing is sent to a speech service.';
  readonly consumesCapturedStream = false;

  private stopped = true;
  private timers = new Set<number>();
  private resolvers = new Set<() => void>();

  async start(context: ProviderContext): Promise<void> {
    this.stopped = false;
    context.emit({
      type: 'status',
      status: 'listening',
      detail: 'Simulated transcript — no audio is being captured.',
    });
    void this.run(context, 0);
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const resolve of this.resolvers) resolve();
    this.resolvers.clear();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const finish = (): void => {
        this.resolvers.delete(finish);
        resolve();
      };
      this.resolvers.add(finish);
      const timer = window.setTimeout(() => {
        this.timers.delete(timer);
        finish();
      }, ms);
      this.timers.add(timer);
    });
  }

  private async run(context: ProviderContext, index: number): Promise<void> {
    if (this.stopped) return;

    if (index >= DEMO_SCRIPT.length) {
      context.emit({
        type: 'status',
        status: 'stopped',
        detail: 'Demo conversation finished. Start again to replay.',
      });
      return;
    }

    const utterance = DEMO_SCRIPT[index];
    if (utterance === undefined) return;

    await this.sleep(utterance.pauseBeforeMs);
    if (this.stopped) return;

    context.emit({ type: 'speech-start', at: Date.now() });

    const words = utterance.text.split(' ');
    let accumulated = '';
    for (const word of words) {
      if (this.stopped) return;
      accumulated = accumulated.length === 0 ? word : `${accumulated} ${word}`;
      context.emit({ type: 'partial', text: accumulated, at: Date.now() });
      // Uneven pacing so it looks like speech, not a metronome.
      await this.sleep(120 + Math.round(Math.random() * 90));
    }

    if (this.stopped) return;
    await this.sleep(220);
    if (this.stopped) return;

    context.emit({ type: 'final', text: utterance.text, at: Date.now() });
    context.emit({ type: 'speech-end', at: Date.now() });

    void this.run(context, index + 1);
  }
}

export const DEMO_PROVIDER_NOTICE = captureError('UNKNOWN', {
  message: 'Demo transcript selected.',
  hint: 'This is a scripted simulation, not live transcription.',
  retryable: false,
});

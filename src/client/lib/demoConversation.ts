import { captureError } from '../../shared/errors';
import type { AudioCaptureMode } from '../../shared/types';

/**
 * Scripted transcript for the Demo provider.
 *
 * It deliberately starts with the worked example from the product spec so the
 * provisional -> refined hand-off is visible within a few seconds, and it is
 * labelled everywhere as a simulation (no audio is captured or sent).
 */
export interface DemoUtterance {
  text: string;
  pauseBeforeMs: number;
}

export const DEMO_SCRIPT: DemoUtterance[] = [
  { pauseBeforeMs: 700, text: 'Could you explain why the application is taking longer to load today?' },
  { pauseBeforeMs: 3200, text: 'Okay. And can you share a rough timeline for the payment module changes?' },
  { pauseBeforeMs: 3000, text: 'One more thing - will the reporting dashboard be included in this release?' },
];

export const DEMO_MODE = 'demo' satisfies AudioCaptureMode;

export const DEMO_WARNING = captureError('UNKNOWN', {
  message: 'Demo mode replays a scripted conversation.',
  hint: 'No audio is captured and no live transcription happens. Switch to tab audio or microphone for a real call.',
  retryable: false,
});

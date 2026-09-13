import type { LoadingPhase } from '../../../shared/activity-schema';

/** Length of the dissolve. Mirrored by the `.loading-overlay` transition in `styles.css`. */
export const OVERLAY_FADE_MS = 300;

export type OverlayVisibility = 'visible' | 'fading' | 'hidden';

/** Where the overlay starts on mount — hidden unless we are genuinely waiting on something. */
export function initialOverlayVisibility(phase: LoadingPhase): OverlayVisibility {
  return phase === 'working' || phase === 'parsing' || phase === 'research' ? 'visible' : 'hidden';
}

/**
 * Pure transition for the loader that covers the timeline. Separate from the React hook so the
 * rule — in particular "a new turn cancels an in-flight fade" — can be tested on its own.
 *
 * `fading` is a one-way door out of `visible`: the timer that lands on `hidden` is the only
 * thing that ends it, so the dissolve always plays in full.
 */
export function nextOverlayVisibility(current: OverlayVisibility, phase: LoadingPhase): OverlayVisibility {
  if (phase !== 'ready') return 'visible';
  return current === 'visible' ? 'fading' : current;
}

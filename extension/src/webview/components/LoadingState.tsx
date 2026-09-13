import { useEffect, useState } from 'react';
import type { LoadingPhase } from '../../../../shared/activity-schema';
import { loadingPhrase } from '../../loading/loadingPhrases';
import { initialOverlayVisibility, nextOverlayVisibility, OVERLAY_FADE_MS, type OverlayVisibility } from '../../loading/overlayVisibility';

const DEFAULT_ROTATE_MS = 3500;

const STAGE_LABEL: Record<LoadingPhase, string> = {
  boot: 'Starting up',
  working: 'Watching the agent work',
  parsing: 'Writing up what happened',
  research: 'Looking for resources and tools',
  ready: '',
};

/**
 * Covers the timeline until the agent's turn is over and Decipher has finished writing it up,
 * so the user never reads a panel that is still changing underneath them.
 */
export function LoadingOverlay({ phase, model, rotateMs, fading }: { phase: LoadingPhase; model?: string; rotateMs?: number; fading: boolean }) {
  return (
    <div className={`loading-overlay${fading ? ' fading' : ''}`} aria-hidden={fading}>
      <LoadingState phase={phase} model={model} rotateMs={rotateMs} />
    </div>
  );
}

/**
 * Tracks the overlay through its dissolve. Returns `visible` while the panel must stay hidden
 * and `fading` for the 300ms reveal; the caller unmounts the overlay once neither is true.
 */
export function useLoadingOverlay(phase: LoadingPhase, viewVisible = true): { visible: boolean; fading: boolean } {
  const [visibility, setVisibility] = useState<OverlayVisibility>(() => initialOverlayVisibility(phase));

  useEffect(() => {
    setVisibility((current) => nextOverlayVisibility(current, phase));
  }, [phase]);

  // Sidebar was hidden while the agent worked; show the loader the moment it is opened again.
  useEffect(() => {
    if (viewVisible && phase !== 'ready' && phase !== 'boot') setVisibility('visible');
  }, [viewVisible, phase]);

  useEffect(() => {
    if (visibility !== 'fading') return;
    const id = setTimeout(() => setVisibility('hidden'), OVERLAY_FADE_MS);
    // A new turn flips us back to `visible`, and this cleanup cancels the half-played fade.
    return () => clearTimeout(id);
  }, [visibility]);

  return { visible: visibility !== 'hidden', fading: visibility === 'fading' };
}

/** The loader itself: branded spinner, rotating phrase, and which stage we are waiting on. */
export function LoadingState({ phase, model, rotateMs = DEFAULT_ROTATE_MS }: { phase: LoadingPhase; model?: string; rotateMs?: number }) {
  const phrase = useRotatingPhrase(model, rotateMs);

  return (
    <div className="loading-state" role="status" aria-live="polite">
      <DecipherSpinner />
      <p className="loading-phrase">{phrase}</p>
      <p className="loading-stage">{STAGE_LABEL[phase]}</p>
    </div>
  );
}

/** A fresh phrase on mount and every `rotateMs`, never the same one twice in a row. */
function useRotatingPhrase(model: string | undefined, rotateMs: number): string {
  const [phrase, setPhrase] = useState(() => loadingPhrase(model));

  useEffect(() => {
    setPhrase(loadingPhrase(model));
    const next = () =>
      setPhrase((current) => {
        // A handful of attempts is plenty; the pools are large enough that repeats are rare.
        for (let i = 0; i < 5; i++) {
          const candidate = loadingPhrase(model);
          if (candidate !== current) return candidate;
        }
        return loadingPhrase(model);
      });
    const id = setInterval(next, Math.max(1200, rotateMs));
    return () => clearInterval(id);
  }, [model, rotateMs]);

  return phrase;
}

/**
 * Three concentric arcs turning at different speeds — a lock being picked.
 * Animation lives in `styles.css` so it inherits the editor's reduced-motion preference.
 */
function DecipherSpinner() {
  return (
    <svg className="decipher-spinner" viewBox="0 0 48 48" width="48" height="48" aria-hidden="true" focusable="false">
      <circle className="ds-track" cx="24" cy="24" r="20" />
      <circle className="ds-track" cx="24" cy="24" r="13" />
      <circle className="ds-arc ds-arc-outer" cx="24" cy="24" r="20" />
      <circle className="ds-arc ds-arc-inner" cx="24" cy="24" r="13" />
      <circle className="ds-core" cx="24" cy="24" r="3.5" />
    </svg>
  );
}

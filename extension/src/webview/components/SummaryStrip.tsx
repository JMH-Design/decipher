import type { SessionState } from '../../../../shared/activity-schema';
import { Spinner } from '../icons';

export function SummaryStrip({ state }: { state: SessionState }) {
  const lastTurn = state.turns[state.turns.length - 1];
  const live = state.liveSummaryKind === 'now';
  const [label, ...rest] = splitLabel(state.liveSummary);
  return (
    <section className={`summary-strip kind-${state.liveSummaryKind} ${lastTurn?.status === 'error' ? 'error' : ''}`} aria-live="polite">
      {live && <Spinner />}
      <div className="summary-text">
        {label && <strong>{label}</strong>}
        <span>{rest.join(':')}</span>
      </div>
      {lastTurn?.userRequest && (
        <div className="summary-request" title={lastTurn.userRequest}>
          You asked: “{lastTurn.userRequest.split('\n')[0].slice(0, 140)}
          {lastTurn.userRequest.length > 140 ? '…' : ''}”
        </div>
      )}
    </section>
  );
}

function splitLabel(text: string): string[] {
  const idx = text.indexOf(':');
  if (idx > 0 && idx < 24) return [text.slice(0, idx + 1), text.slice(idx + 1)];
  return ['', text];
}

import type { SessionState } from '../../../../shared/activity-schema';
import { Spinner } from '../icons';

const EYEBROW: Record<SessionState['liveSummaryKind'], string> = {
  now: 'Right now',
  turn: 'This turn',
  idle: 'Nothing yet',
};

/**
 * The recap docked under the timeline. It is the first thing the user sees when the loader
 * dissolves, so it is styled as its own surface rather than as one more step card.
 */
export function TurnRecap({ state }: { state: SessionState }) {
  const lastTurn = state.turns[state.turns.length - 1];
  const outcome = lastTurn?.status === 'error' ? 'error' : lastTurn?.status === 'aborted' ? 'aborted' : '';
  const request = lastTurn?.userRequest?.split('\n').find((l) => l.trim())?.trim();

  return (
    <section className={`turn-recap kind-${state.liveSummaryKind} ${outcome}`} aria-live="polite">
      <p className="recap-eyebrow">
        {state.liveSummaryKind === 'now' && <Spinner />}
        <span>{EYEBROW[state.liveSummaryKind]}</span>
      </p>
      <h2 className="recap-headline">{state.liveHeadline}</h2>
      <p className="recap-body">{state.liveSummary}</p>
      {request && (
        <p className="recap-request" title={request}>
          You asked: “{request.slice(0, 140)}
          {request.length > 140 ? '…' : ''}”
        </p>
      )}
    </section>
  );
}

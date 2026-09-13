import { useEffect, useMemo, useRef, useState } from 'react';
import type { ExplainedStep, SessionState, Turn } from '../../../../shared/activity-schema';
import { StepCard } from './StepCard';

const INITIAL_WINDOW = 60;

export function Timeline({ state, onOpenConcept }: { state: SessionState; onOpenConcept: (id: string) => void }) {
  const [windowSize, setWindowSize] = useState(INITIAL_WINDOW);
  const endRef = useRef<HTMLDivElement>(null);
  const prevCount = useRef(0);

  const topLevel = useMemo(() => state.steps.filter((s) => !s.subagentId), [state.steps]);
  const children = useMemo(() => {
    const map = new Map<string, ExplainedStep[]>();
    for (const s of state.steps) {
      if (s.parentStepId) {
        const list = map.get(s.parentStepId) ?? [];
        list.push(s);
        map.set(s.parentStepId, list);
      }
    }
    return map;
  }, [state.steps]);

  // Windowed rendering: show the most recent N steps; "Show earlier" reveals more.
  const hidden = Math.max(0, topLevel.length - windowSize);
  const visible = topLevel.slice(hidden);

  const groups = useMemo(() => groupByTurn(visible, state.turns), [visible, state.turns]);

  useEffect(() => {
    if (state.steps.length > prevCount.current) endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
    prevCount.current = state.steps.length;
  }, [state.steps.length]);

  if (!state.conversationId) {
    return <div className="empty">Start a chat with the agent — I’ll explain everything here.</div>;
  }
  if (!state.steps.length) {
    const t = state.turns[state.turns.length - 1];
    return <div className="empty">{t?.finalResponse ? 'The agent replied without taking any actions in this chat.' : 'No agent actions recorded yet. As soon as the agent reads, searches, edits, or runs something, it will show up here.'}</div>;
  }

  return (
    <div className="timeline">
      {hidden > 0 && (
        <button className="show-earlier" onClick={() => setWindowSize((n) => n + INITIAL_WINDOW)}>
          Show {Math.min(hidden, INITIAL_WINDOW)} earlier actions ({hidden} hidden)
        </button>
      )}
      {groups.map(({ turn, steps }) => (
        <section key={turn?.index ?? 'none'} className={`turn turn-${turn?.status ?? 'active'}`}>
          <header className="turn-header">
            <span className="turn-index">Turn {(turn?.index ?? 0) + 1}</span>
            {turn?.userRequest && <span className="turn-request">“{turn.userRequest.split('\n')[0].slice(0, 110)}”</span>}
            {turn?.status === 'error' && <span className="turn-status error">Something went wrong</span>}
            {turn?.status === 'aborted' && <span className="turn-status">Stopped early</span>}
            {turn?.status === 'active' && <span className="turn-status live">In progress</span>}
          </header>
          {turn?.userRequest && /plan/i.test(turn.userRequest) && steps.every((s) => s.category !== 'editing') && <div className="plan-note">The agent is planning only — no file changes in this turn.</div>}
          <ol className="steps">
            {steps.map((s) => (
              <StepCard key={s.id} step={s} state={state} childSteps={children.get(s.id)} onOpenConcept={onOpenConcept} />
            ))}
          </ol>
        </section>
      ))}
      <div ref={endRef} />
    </div>
  );
}

function groupByTurn(steps: ExplainedStep[], turns: Turn[]): Array<{ turn: Turn | undefined; steps: ExplainedStep[] }> {
  const out: Array<{ turn: Turn | undefined; steps: ExplainedStep[] }> = [];
  for (const s of steps) {
    const last = out[out.length - 1];
    if (last && last.turn?.index === s.turnIndex) last.steps.push(s);
    else out.push({ turn: turns[s.turnIndex], steps: [s] });
  }
  return out;
}

import { useState } from 'react';
import type { ExplainedStep, SessionState } from '../../../../shared/activity-schema';
import { CategoryIcon, Chevron, Spinner } from '../icons';
import { post } from '../vscodeApi';
import { LearnMore } from './LearnMore';

export function StepCard({ step, state, childSteps, onOpenConcept }: { step: ExplainedStep; state: SessionState; childSteps?: ExplainedStep[]; onOpenConcept: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [showChildren, setShowChildren] = useState(false);
  const e = step.explanation;
  const isError = step.status === 'error';
  const filePath = typeof step.input.path === 'string' ? step.input.path : undefined;

  return (
    <li className={`step cat-${step.category} status-${step.status} ${step.subagentId ? 'sub' : ''}`}>
      <div className="step-main">
        <div className="step-icon">{step.status === 'running' ? <Spinner /> : <CategoryIcon category={step.category} />}</div>
        <div className="step-body">
          <div className="step-title-row">
            <span className="step-title">{isError ? 'Something went wrong' : e.title}</span>
            <span className="step-meta">
              {step.source === 'hook' && <span className="pill hook" title="Enriched with real output from hooks">live</span>}
              {step.durationMs !== undefined && step.durationMs > 1500 && <span className="pill">{formatDuration(step.durationMs)}</span>}
              {relativeTime(step.timestamp)}
            </span>
          </div>
          <p className="step-summary">{e.summary}</p>
          {isError && step.errorMessage && <p className="step-error">{step.errorMessage.split('\n')[0].slice(0, 200)}</p>}
          {state.mode === 'intermediate' && e.technical && <code className="step-hint">{truncate(e.technical, 90)}</code>}
          {state.mode === 'advanced' && e.technical && <pre className="step-technical">{e.technical}</pre>}
          {step.conceptIds.length > 0 && (
            <div className="concept-tags">
              {step.conceptIds.slice(0, 4).map((id) => {
                const c = state.concepts[id];
                if (!c) return null;
                const status = state.profile.concepts[id]?.status ?? 'new';
                return (
                  <button key={id} className={`tag status-${status}`} onClick={() => onOpenConcept(id)} title={c.plainSummary}>
                    {c.label}
                    {status === 'new' && <span className="tag-new">new</span>}
                  </button>
                );
              })}
            </div>
          )}
          <div className="step-actions">
            <button className="learn-more" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              <Chevron open={open} /> Learn more
            </button>
            {filePath && (
              <button className="link" onClick={() => post({ type: 'openFile', path: filePath })}>
                Open file
              </button>
            )}
            {childSteps && childSteps.length > 0 && (
              <button className="link" onClick={() => setShowChildren((s) => !s)}>
                {showChildren ? 'Hide' : 'Show'} {childSteps.length} helper actions
              </button>
            )}
          </div>
          {open && <LearnMore step={step} state={state} onOpenConcept={onOpenConcept} />}
        </div>
      </div>
      {showChildren && childSteps && (
        <ol className="steps sub-steps">
          {childSteps.map((c) => (
            <StepCard key={c.id} step={c} state={state} onOpenConcept={onOpenConcept} />
          ))}
        </ol>
      )}
    </li>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

function relativeTime(ts?: number): string {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} h ago`;
  return new Date(ts).toLocaleDateString();
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

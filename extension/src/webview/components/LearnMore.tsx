import { useState } from 'react';
import type { Explanation, ExplainedStep, SessionState } from '../../../../shared/activity-schema';

export function LearnMore({ step, state, onOpenConcept }: { step: ExplainedStep; state: SessionState; onOpenConcept: (id: string) => void }) {
  const e = step.explanation;
  const vocabulary = e.vocabulary.filter((id) => state.glossary[id]);

  return (
    <div className="learn-more-body">
      <Section title="What happened">
        <p>{e.whatHappened}</p>
        {e.llmEnhanced && <span className="pill">AI summary</span>}
      </Section>

      {e.subSteps && e.subSteps.length > 1 && (
        <Section title="Step by step">
          <ol className="sub-explanations">
            {e.subSteps.map((s, i) => (
              <SubStep key={i} explanation={s} />
            ))}
          </ol>
        </Section>
      )}

      {e.technical && (
        <Section title="The technical version">
          <pre className="technical">{e.technical}</pre>
        </Section>
      )}

      {step.output && step.source === 'hook' && (
        <Section title="What came back">
          <pre className="technical output">{trimOutput(step.output)}</pre>
        </Section>
      )}

      {vocabulary.length > 0 && (
        <Section title="Vocabulary">
          <ul className="vocab">
            {vocabulary.map((id) => (
              <VocabItem key={id} id={id} state={state} />
            ))}
          </ul>
        </Section>
      )}

      {e.whyItMatters && (
        <Section title="Why it matters">
          <p>{e.whyItMatters}</p>
        </Section>
      )}

      {step.conceptIds.length > 0 && (
        <Section title="Concepts to learn">
          <ul className="concept-list">
            {step.conceptIds.map((id) => {
              const c = state.concepts[id];
              if (!c) return null;
              return (
                <li key={id}>
                  <button className="link" onClick={() => onOpenConcept(id)}>
                    {c.label}
                  </button>
                  <span className="muted"> — {c.plainSummary}</span>
                </li>
              );
            })}
          </ul>
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="lm-section">
      <h4>{title}</h4>
      {children}
    </div>
  );
}

function SubStep({ explanation }: { explanation: Explanation }) {
  return (
    <li>
      <strong>{explanation.title}</strong> — {explanation.summary}
      {explanation.technical && <code className="inline-tech">{explanation.technical}</code>}
    </li>
  );
}

function VocabItem({ id, state }: { id: string; state: SessionState }) {
  const term = state.glossary[id];
  const [open, setOpen] = useState(false);
  if (!term) return null;
  return (
    <li className={open ? 'open' : ''}>
      <button className="vocab-term" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {term.term}
      </button>
      {open ? (
        <div className="vocab-def">
          <p>{term.definition}</p>
          {term.analogy && <p className="analogy">{term.analogy}</p>}
        </div>
      ) : (
        <span className="vocab-short"> — {term.definition.split(/(?<=\.)\s/)[0]}</span>
      )}
    </li>
  );
}

function trimOutput(out: string): string {
  const lines = out.split('\n');
  return lines.length > 30 ? `${lines.slice(0, 30).join('\n')}\n… (${lines.length - 30} more lines)` : out.slice(0, 4000);
}

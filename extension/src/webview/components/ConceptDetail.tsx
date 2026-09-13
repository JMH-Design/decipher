import type { KnowledgeConcept, ScoredConcept, SessionState } from '../../../../shared/activity-schema';
import { post } from '../vscodeApi';

export function ConceptDetail({ concept, scored, state, onBack }: { concept: KnowledgeConcept; scored?: ScoredConcept; state: SessionState; onBack: () => void }) {
  const entry = state.profile.concepts[concept.id];
  const status = entry?.status ?? 'new';
  const evidence = scored?.detected.evidence.filter((e) => e.kind !== 'request') ?? state.steps.filter((s) => s.conceptIds.includes(concept.id)).slice(0, 4).map((s) => ({ kind: 'file' as const, detail: s.explanation.title, file: typeof s.input.path === 'string' ? s.input.path : undefined, stepId: s.id }));
  const files = [...new Set(evidence.map((e) => e.file).filter((f): f is string => Boolean(f)))];
  const lastRequest = state.turns.map((t) => t.userRequest).filter(Boolean).pop();
  const missingPrereqs = (scored?.missingPrerequisites ?? concept.prerequisites.filter((p) => state.profile.concepts[p]?.status !== 'learned')).map((id) => state.concepts[id]).filter(Boolean);

  return (
    <article className="concept-detail">
      <button className="link back" onClick={onBack}>
        ← Back
      </button>
      <header>
        <h2>{concept.label}</h2>
        <div className="concept-meta">
          <span className={`pill depth-${concept.depth}`}>{concept.depth}</span>
          <span className="pill">{concept.category}</span>
          {scored && <span className="pill debt">{scored.debt} debt pts</span>}
          <span className={`pill status-${status}`}>{status === 'new' ? 'new to you' : status}</span>
          {entry && entry.exposures > 1 && <span className="muted small">seen in {entry.exposures} chats</span>}
        </div>
        <p className="concept-summary">{concept.plainSummary}</p>
      </header>

      {files.length > 0 && (
        <section>
          <h4>Used in</h4>
          <ul className="file-list">
            {files.slice(0, 5).map((f) => (
              <li key={f}>
                <button className="link" onClick={() => post({ type: 'openFile', path: f })}>
                  {f.split('/').pop()}
                </button>
                <span className="muted small"> {evidenceFor(evidence, f)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h4>Why the agent used it</h4>
        <p>
          {lastRequest && (
            <>
              You asked: “{lastRequest.split('\n')[0].slice(0, 120)}”.{' '}
            </>
          )}
          {concept.whyUsed ?? `${concept.label} was part of getting that done.`}
        </p>
      </section>

      {missingPrereqs.length > 0 && (
        <section>
          <h4>Learn these first</h4>
          <ul className="prereqs">
            {missingPrereqs.map((p) => (
              <li key={p.id}>
                <span>{p.label}</span>
                <span className="muted small"> — {p.plainSummary}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {concept.topics.length > 0 && (
        <section>
          <h4>Learn in order</h4>
          <ol className="topics">
            {concept.topics.map((t, i) => (
              <li key={t.id}>
                <span className="topic-num">{i + 1}.</span> {t.label} <span className="muted small">({t.minutes} min)</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {concept.resources.length > 0 && (
        <section>
          <h4>Resources</h4>
          <ul className="resources">
            {concept.resources.map((r, i) => (
              <li key={i}>
                <button className="link" onClick={() => post({ type: 'openResource', resource: r })}>
                  {r.title}
                </button>
                <span className="pill small">{r.type === 'skill' ? 'your skill' : r.type}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer className="concept-actions">
        {status !== 'learned' ? (
          <button className="primary" onClick={() => post({ type: 'markConcept', conceptId: concept.id, status: 'learned' })}>
            ✓ Mark as learned
          </button>
        ) : (
          <button onClick={() => post({ type: 'markConcept', conceptId: concept.id, status: 'learning' })}>Un-mark learned</button>
        )}
        {status === 'new' && <button onClick={() => post({ type: 'markConcept', conceptId: concept.id, status: 'learning' })}>I’m learning this</button>}
        <button onClick={() => post({ type: 'askAgent', conceptId: concept.id })} title="Copies a teaching prompt you can paste into the chat">
          Ask the agent to explain
        </button>
      </footer>
    </article>
  );
}

function evidenceFor(evidence: Array<{ kind: string; detail: string; file?: string }>, file: string): string {
  const e = evidence.filter((x) => x.file === file).slice(0, 3);
  return e.length ? `(${e.map((x) => x.detail).join(', ')})` : '';
}

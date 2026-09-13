import type { KnowledgeConcept, ResourceType, SessionState } from '../../../../shared/activity-schema';
import { post } from '../vscodeApi';

/** Grouped so official docs and videos never sit in one undifferentiated list. */
const RESOURCE_GROUPS: Array<{ types: ResourceType[]; label: string }> = [
  { types: ['official'], label: 'Official docs' },
  { types: ['video'], label: 'Watch' },
  { types: ['course', 'workshop'], label: 'Courses and workshops' },
  { types: ['tutorial', 'explainer'], label: 'Tutorials' },
  { types: ['skill'], label: 'Installed on your machine' },
];

export function ConceptDetail({ concept, state, onBack }: { concept: KnowledgeConcept; state: SessionState; onBack: () => void }) {
  const session = state.sessionConcepts.find((c) => c.concept.id === concept.id);
  const files = session?.files ?? [];
  const prerequisites = concept.prerequisites.map((id) => state.concepts[id]).filter(Boolean);
  const totalMinutes = concept.topics.reduce((n, t) => n + t.minutes, 0);

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
          {totalMinutes > 0 && <span className="muted small">~{totalMinutes} min to work through</span>}
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
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h4>Why the agent used it</h4>
        <p>
          {state.goal && <>You asked: “{state.goal.split('\n')[0].slice(0, 120)}”. </>}
          {concept.whyUsed ?? `${concept.label} was part of getting that done.`}
        </p>
      </section>

      {prerequisites.length > 0 && (
        <section>
          <h4>Helps to know first</h4>
          <ul className="prereqs">
            {prerequisites.map((p) => (
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

      {RESOURCE_GROUPS.map(({ types, label }) => {
        const items = concept.resources.filter((r) => types.includes(r.type));
        if (!items.length) return null;
        return (
          <section key={label}>
            <h4>{label}</h4>
            <ul className="resources">
              {items.map((resource, i) => (
                <li key={`${resource.title}-${i}`}>
                  <button className="link" onClick={() => post({ type: 'openResource', resource })}>
                    {resource.title}
                  </button>
                  {resource.type === 'skill' && <span className="pill small">installed locally</span>}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </article>
  );
}
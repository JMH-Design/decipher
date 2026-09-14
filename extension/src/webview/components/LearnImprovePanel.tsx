import type { Recommendation, ResourceType, SessionResource, SessionState } from '../../../../shared/activity-schema';
import { post } from '../vscodeApi';

/** Learning resources are grouped by how you consume them, not by which concept they came from. */
const RESOURCE_GROUPS: Array<{ types: ResourceType[]; label: string }> = [
  { types: ['video'], label: 'Watch' },
  { types: ['course', 'workshop'], label: 'Courses and workshops' },
  { types: ['official'], label: 'Official docs' },
  { types: ['tutorial', 'explainer'], label: 'Read' },
  { types: ['skill'], label: 'Already on your machine' },
];

const KIND_LABEL: Record<Recommendation['kind'], string> = {
  tool: 'Tool',
  mcp: 'MCP server',
  kit: 'Starter kit',
  service: 'Service',
  course: 'Course',
};

export function LearnImprovePanel({ state, onOpenConcept }: { state: SessionState; onOpenConcept: (id: string) => void }) {
  if (!state.conversationId) {
    return <div className="empty">Pick a chat to see what you could learn from it.</div>;
  }

  return (
    <div className="learn-panel">
      <Goal state={state} />
      <Concepts state={state} onOpenConcept={onOpenConcept} />
      <Resources resources={state.resources} />
      <Improve state={state} />
    </div>
  );
}

function Goal({ state }: { state: SessionState }) {
  if (!state.goal) return null;
  return (
    <section className="learn-card">
      <h3>What you asked for</h3>
      <p className="goal-quote">“{state.goal.split('\n').find((l) => l.trim())?.slice(0, 240)}”</p>
      <p className="muted small">{state.liveSummary}</p>
    </section>
  );
}

function Concepts({ state, onOpenConcept }: { state: SessionState; onOpenConcept: (id: string) => void }) {
  if (!state.sessionConcepts.length) {
    return (
      <section className="learn-card">
        <h3>Concepts in this chat</h3>
        <p className="muted">Nothing to learn yet. Concepts show up once the agent edits code, installs a package, or reads a skill.</p>
      </section>
    );
  }
  return (
    <section className="learn-card">
      <h3>Concepts in this chat</h3>
      <p className="muted small">The ideas behind what the agent did. Open one to see how to learn it.</p>
      <div className="concept-tags">
        {state.sessionConcepts.map(({ concept }) => (
          <button key={concept.id} className="tag" onClick={() => onOpenConcept(concept.id)} title={concept.plainSummary}>
            {concept.label}
          </button>
        ))}
      </div>
    </section>
  );
}

function Resources({ resources }: { resources: SessionResource[] }) {
  if (!resources.length) return null;
  return (
    <section className="learn-card">
      <h3>Learning resources</h3>
      {RESOURCE_GROUPS.map(({ types, label }) => {
        const items = resources.filter((r) => types.includes(r.resource.type));
        if (!items.length) return null;
        return (
          <div className="resource-group" key={label}>
            <h4>{label}</h4>
            <ul className="resources">
              {items.map(({ resource, conceptLabel }, i) => (
                <li key={`${resource.title}-${i}`}>
                  <button className="link" onClick={() => post({ type: 'openResource', resource })}>
                    {resource.title}
                  </button>
                  <span className="muted small"> · {conceptLabel}</span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      <div className="learn-actions">
        <button onClick={() => post({ type: 'exportResourceSheet' })}>Export as Markdown</button>
      </div>
    </section>
  );
}

function Improve({ state }: { state: SessionState }) {
  const { recommendations, researchStatus, researchNote, webSearchConfigured } = state;

  return (
    <section className="learn-card">
      <h3>Tools that could help</h3>
      <p className="muted small">Things that could get you the same result with less effort, or a better one.</p>

      {recommendations.length > 0 ? (
        <ul className="recommendations">
          {recommendations.map((rec) => (
            <RecommendationCard key={rec.id} rec={rec} />
          ))}
        </ul>
      ) : (
        <p className="muted">
          {researchStatus === 'error'
            ? 'Could not put suggestions together for this chat.'
            : 'No suggestions yet — they appear once the agent has finished a turn.'}
        </p>
      )}

      {researchNote && <p className="muted small note">{researchNote}</p>}

      <div className="learn-actions">
        <button onClick={() => post({ type: 'researchNow' })}>Refresh suggestions</button>
        {!webSearchConfigured && (
          <button onClick={() => post({ type: 'configureWebSearch' })} title="Adds a Context.dev API key so Lumen can search the live web">
            Set up web search
          </button>
        )}
      </div>
    </section>
  );
}

function RecommendationCard({ rec }: { rec: Recommendation }) {
  return (
    <li className="recommendation">
      <div className="rec-head">
        {rec.url ? (
          <button className="link rec-title" onClick={() => post({ type: 'openResource', resource: { type: 'official', title: rec.title, url: rec.url } })}>
            {rec.title}
          </button>
        ) : (
          <span className="rec-title">{rec.title}</span>
        )}
        <span className="pill">{KIND_LABEL[rec.kind]}</span>
        {rec.source === 'researched' && (
          <span className="pill" title="Found by searching the web for this chat">
            found for you
          </span>
        )}
      </div>
      <p className="rec-summary">{rec.summary}</p>
      <p className="muted small">Worth a look because {rec.whyForYou}</p>
    </li>
  );
}

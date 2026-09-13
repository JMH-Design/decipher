import type { ScoredConcept, SessionState } from '../../../../shared/activity-schema';
import { post } from '../vscodeApi';

export function DebtPanel({ state, onOpenConcept }: { state: SessionState; onOpenConcept: (id: string) => void }) {
  const debt = state.debt;
  const queue = debt?.queue.filter((q) => q.status !== 'learned') ?? [];
  const learned = debt?.queue.filter((q) => q.status === 'learned') ?? [];
  const totalLearned = Object.values(state.profile.concepts).filter((c) => c.status === 'learned').length;

  return (
    <div className="debt-panel">
      <section className="debt-card">
        <h3>Knowledge debt — this chat</h3>
        {debt && queue.length > 0 ? (
          <>
            <div className="debt-stats">
              <Stat value={debt.totalDebt} label="debt points" />
              <Stat value={debt.newConcepts} label={debt.newConcepts === 1 ? 'new concept' : 'new concepts'} />
              <Stat value={`~${debt.estimatedMinutes}`} label="min to learn" />
            </div>
            <p className="muted small">Debt is the gap between what the agent used and what you’ve marked as learned. It goes down as you learn.</p>
            <ol className="queue">
              {queue.map((q, i) => (
                <QueueItem key={q.concept.id} index={i + 1} item={q} maxDebt={queue[0].debt || 1} onOpen={() => onOpenConcept(q.concept.id)} />
              ))}
            </ol>
            <div className="debt-actions">
              <button onClick={() => post({ type: 'markAllSeen' })} title="Move every new concept to 'learning' so it stops counting as brand new">
                Mark all as seen
              </button>
              <button onClick={() => post({ type: 'exportLearningPlan' })}>Export learning plan</button>
            </div>
          </>
        ) : (
          <p className="muted">
            {state.conversationId
              ? debt
                ? 'Everything the agent used here is something you’ve already learned. Nice.'
                : 'No learnable concepts detected yet. Concepts appear when the agent edits code, installs packages, or reads a skill.'
              : 'Pick a chat to see what you could learn from it.'}
          </p>
        )}
        {learned.length > 0 && (
          <p className="muted small">
            Already learned and used here: {learned.map((l) => l.concept.label).join(', ')}.
          </p>
        )}
      </section>

      {state.blindSpots.length > 0 && (
        <section className="debt-card">
          <h3>Recurring blind spots</h3>
          <p className="muted small">Concepts the agent keeps using that you haven’t marked as learned.</p>
          <ul className="blind-spots">
            {state.blindSpots.map((b) => (
              <li key={b.concept.id}>
                <button className="link" onClick={() => onOpenConcept(b.concept.id)}>
                  {b.concept.label}
                </button>
                <span className="muted"> — seen in {b.exposures} chats</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="debt-card progress">
        <h3>Your progress</h3>
        <div className="debt-stats">
          <Stat value={totalLearned} label="concepts learned" />
          <Stat value={state.profile.totalDebtPaid} label="debt paid off" />
          <Stat value={state.profile.sessionsReviewed} label="chats reviewed" />
        </div>
      </section>
    </div>
  );
}

function Stat({ value, label }: { value: number | string; label: string }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function QueueItem({ index, item, maxDebt, onOpen }: { index: number; item: ScoredConcept; maxDebt: number; onOpen: () => void }) {
  const review = item.novelty < 1;
  return (
    <li className={`queue-item ${review ? 'review' : ''}`}>
      <div className="queue-row">
        <span className="queue-index">{index}.</span>
        <button className="queue-label" onClick={onOpen}>
          {item.concept.label}
          {review && <span className="muted"> (review)</span>}
        </button>
        <span className="queue-min">{item.minutes} min</span>
        <button className="learn-btn" onClick={onOpen}>
          {review ? 'Review →' : 'Learn →'}
        </button>
      </div>
      <div className="debt-bar" title={`${item.debt} debt points`}>
        <div className="debt-fill" style={{ width: `${Math.max(6, (item.debt / maxDebt) * 100)}%` }} />
      </div>
      <div className="queue-summary muted small">{item.concept.plainSummary}</div>
    </li>
  );
}

import { useEffect, useMemo, useState } from 'react';
import type { ExplainMode, SessionState } from '../../../shared/activity-schema';
import { ConceptDetail } from './components/ConceptDetail';
import { LearnImprovePanel } from './components/LearnImprovePanel';
import { LoadingOverlay, LoadingState, useLoadingOverlay } from './components/LoadingState';
import { Timeline } from './components/Timeline';
import { TurnRecap } from './components/TurnRecap';
import { getUiState, onMessage, post, setUiState } from './vscodeApi';

type Tab = 'activity' | 'learn';

interface UiState {
  tab: Tab;
  openConcept?: string;
}

export function App() {
  const [state, setState] = useState<SessionState | null>(null);
  const [ui, setUi] = useState<UiState>(() => getUiState<UiState>() ?? { tab: 'activity' });
  const [toast, setToast] = useState<string | null>(null);
  const [viewVisible, setViewVisible] = useState(true);

  useEffect(() => {
    const off = onMessage((msg) => {
      if (msg.type === 'state') setState(msg.state);
      if (msg.type === 'viewVisible') setViewVisible(true);
      if (msg.type === 'viewHidden') setViewVisible(false);
      if (msg.type === 'toast') {
        setToast(msg.text);
        setTimeout(() => setToast(null), 3500);
      }
    });
    post({ type: 'ready' });
    return off;
  }, []);

  useEffect(() => setUiState(ui), [ui]);

  const conversationTitle = useMemo(() => state?.conversations.find((c) => c.id === state.conversationId)?.title, [state]);
  const overlay = useLoadingOverlay(state?.loadingPhase ?? 'boot', viewVisible);

  // No state yet: the host has not finished its first build.
  if (!state) {
    return (
      <div className="app">
        <LoadingState phase="boot" />
      </div>
    );
  }

  const openConcept = ui.openConcept ? state.concepts[ui.openConcept] : undefined;

  return (
    <div className={`app mode-${state.mode}`}>
      <header className="topbar">
        <div className="topbar-row">
          <select className="conversation-picker" value={state.conversationId ?? ''} onChange={(e) => post({ type: 'selectConversation', conversationId: e.target.value })} title="Which chat to explain">
            {!state.conversationId && <option value="">No chat selected</option>}
            {state.conversations.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
          <ModeToggle mode={state.mode} />
        </div>
        <nav className="tabs" role="tablist">
          <button role="tab" aria-selected={ui.tab === 'activity'} className={ui.tab === 'activity' ? 'active' : ''} onClick={() => setUi({ tab: 'activity' })}>
            What happened
          </button>
          <button role="tab" aria-selected={ui.tab === 'learn'} className={ui.tab === 'learn' ? 'active' : ''} onClick={() => setUi({ tab: 'learn' })}>
            Learn &amp; improve
          </button>
        </nav>
      </header>

      {/* Hooks only exist in Cursor; elsewhere the absence is expected, not a setup step. */}
      {state.hooksSupported && !state.hooksInstalled && (
        <div className="banner">
          <span>Install Lumen hooks to see results (what a search found, whether a command succeeded).</span>
          <button className="link" onClick={() => post({ type: 'installHooks' })}>
            Install
          </button>
        </div>
      )}

      {state.sourceNote && <div className="banner subtle">{state.sourceNote}</div>}

      {/* The cards build underneath the overlay, so the panel is complete the moment it shows. */}
      <div className="stage">
        <div className="stage-body" aria-hidden={overlay.visible} aria-busy={overlay.visible}>
          <main className="content">
            {openConcept ? (
              <ConceptDetail concept={openConcept} state={state} onBack={() => setUi({ tab: ui.tab })} />
            ) : ui.tab === 'activity' ? (
              <Timeline state={state} onOpenConcept={(id) => setUi({ tab: 'activity', openConcept: id })} />
            ) : (
              <LearnImprovePanel state={state} onOpenConcept={(id) => setUi({ tab: 'learn', openConcept: id })} />
            )}
          </main>
          {!openConcept && <TurnRecap state={state} />}
        </div>

        {overlay.visible && <LoadingOverlay phase={state.loadingPhase} model={state.agentModel} rotateMs={state.loadingRotateMs} fading={overlay.fading} agent={state.agentShortLabel} />}
      </div>

      {toast && <div className="toast">{toast}</div>}
      <footer className="footer">
        <span title={conversationTitle}>{state.workspaceName}</span>
        <span className="dot">·</span>
        <span title={`Explaining ${state.agentLabel}`}>{state.agentShortLabel}</span>
        <span className="dot">·</span>
        <span>{state.steps.length} actions</span>
        {state.llmAvailable && (
          <>
            <span className="dot">·</span>
            <span title="Complex turns get an AI-written summary">AI summaries on</span>
          </>
        )}
        <button className="link" onClick={() => post({ type: 'refresh' })} title="Re-read the transcript">
          Refresh
        </button>
      </footer>
    </div>
  );
}

function ModeToggle({ mode }: { mode: ExplainMode }) {
  const modes: Array<{ id: ExplainMode; label: string; title: string }> = [
    { id: 'beginner', label: 'Plain', title: 'Plain language only; technical detail under Learn more' },
    { id: 'intermediate', label: 'Hints', title: 'Show a short technical hint on each step' },
    { id: 'advanced', label: 'Full', title: 'Show the full command on each step' },
  ];
  return (
    <div className="mode-toggle" role="radiogroup" aria-label="Detail level">
      {modes.map((m) => (
        <button key={m.id} role="radio" aria-checked={mode === m.id} className={mode === m.id ? 'active' : ''} title={m.title} onClick={() => post({ type: 'setMode', mode: m.id })}>
          {m.label}
        </button>
      ))}
    </div>
  );
}

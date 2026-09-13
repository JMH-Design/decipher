import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ExplainMode, FromWebviewMessage, Resource, SessionState, ToWebviewMessage } from '../../shared/activity-schema';
import { LlmSummarizer } from './explainer/llmSummarizer';
import { TemplateEngine } from './explainer/templateEngine';
import { VscodeLmProvider } from './explainer/vscodeLmProvider';
import { GlossaryService } from './glossary/glossaryService';
import { DebtTracker } from './knowledge/debtTracker';
import { KnowledgeGraph } from './knowledge/knowledgeGraph';
import { ProfileStore } from './knowledge/profileStore';
import { expandHome, resolvePaths, type DecipherPaths } from './paths';
import { SessionBuilder } from './session/sessionBuilder';
import { ActivityWatcher } from './session/watcher';

const VIEW_ID = 'decipher.activityView';
const LOCAL_PLUGIN_DIR = path.join(os.homedir(), '.cursor', 'plugins', 'local', 'decipher-hooks');

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Decipher');
  context.subscriptions.push(output);

  const workspace = vscode.workspace.workspaceFolders?.[0];
  if (!workspace) {
    output.appendLine('No workspace folder open; Decipher is idle.');
    return;
  }

  const controller = new DecipherController(context, workspace.uri.fsPath, output);
  context.subscriptions.push(controller);

  const provider = new ActivityViewProvider(context.extensionUri, controller);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(VIEW_ID, provider, { webviewOptions: { retainContextWhenHidden: true } }));

  context.subscriptions.push(
    vscode.commands.registerCommand('decipher.open', () => vscode.commands.executeCommand(`${VIEW_ID}.focus`)),
    vscode.commands.registerCommand('decipher.refresh', () => controller.refresh('manual')),
    vscode.commands.registerCommand('decipher.installHooks', () => controller.installHooks()),
    vscode.commands.registerCommand('decipher.exportLearningPlan', () => controller.exportLearningPlan()),
    vscode.commands.registerCommand('decipher.resetProfile', () => controller.resetProfile()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('decipher')) controller.reloadConfig();
    }),
  );

  controller.start();
}

export function deactivate(): void {
  /* disposables handle cleanup */
}

// ---------------------------------------------------------------------------

class DecipherController implements vscode.Disposable {
  private paths: DecipherPaths;
  private readonly glossary = new GlossaryService();
  private readonly graph = new KnowledgeGraph();
  private readonly debt = new DebtTracker(this.graph);
  private profile: ProfileStore;
  private engine: TemplateEngine;
  private llm: LlmSummarizer;
  private builder: SessionBuilder;
  private watcher: ActivityWatcher | undefined;
  private state: SessionState | undefined;
  private selectedConversation: string | null = null;
  private llmAvailable = false;
  private llmAbort: AbortController | undefined;
  private readonly listeners = new Set<(s: SessionState) => void>();
  private readonly toasts = new Set<(t: string) => void>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly workspaceRoot: string,
    private readonly output: vscode.OutputChannel,
  ) {
    this.paths = resolvePaths(workspaceRoot, this.config<string>('cursorProjectsDir') || undefined);
    this.profile = new ProfileStore(this.paths.profilePath);
    this.engine = new TemplateEngine({ glossary: this.glossary, workspaceRoot });
    this.llm = new LlmSummarizer(new VscodeLmProvider(), this.llmOptions());
    this.builder = this.makeBuilder();
    output.appendLine(`Cursor project dir: ${this.paths.projectDir}`);
  }

  private config<T>(key: string): T | undefined {
    return vscode.workspace.getConfiguration('decipher').get<T>(key);
  }

  private llmOptions() {
    return {
      enabled: this.config<boolean>('llm.enabled') ?? true,
      alwaysExplainInDepth: this.config<boolean>('llm.alwaysExplainInDepth') ?? false,
      conceptExtraction: this.config<boolean>('llm.conceptExtraction') ?? false,
    };
  }

  private makeBuilder(): SessionBuilder {
    return new SessionBuilder({
      paths: this.paths,
      workspaceName: path.basename(this.workspaceRoot),
      engine: this.engine,
      glossary: this.glossary,
      graph: this.graph,
      debt: this.debt,
      profile: this.profile,
      llm: this.llm,
      maxQueue: this.config<number>('maxVisibleQueue') ?? 5,
    });
  }

  start(): void {
    this.watcher = new ActivityWatcher([this.paths.transcriptsDir, this.paths.eventsDir], () => this.refresh('watch'));
    this.watcher.start();
    this.profile.onChange(() => this.refresh('profile'));
    void this.llm.isAvailable().then((ok) => {
      this.llmAvailable = ok;
      this.output.appendLine(`Language model ${ok ? 'available' : 'unavailable'} — ${ok ? 'complex turns will get richer summaries' : 'using templates only'}.`);
      this.refresh('llm');
    });
    this.refresh('start');
  }

  reloadConfig(): void {
    this.paths = resolvePaths(this.workspaceRoot, this.config<string>('cursorProjectsDir') || undefined);
    this.llm.setOptions(this.llmOptions());
    this.builder = this.makeBuilder();
    this.watcher?.stop();
    this.start();
  }

  get mode(): ExplainMode {
    return this.config<ExplainMode>('mode') ?? 'beginner';
  }

  onState(fn: (s: SessionState) => void): vscode.Disposable {
    this.listeners.add(fn);
    if (this.state) fn(this.state);
    return new vscode.Disposable(() => this.listeners.delete(fn));
  }

  onToast(fn: (t: string) => void): vscode.Disposable {
    this.toasts.add(fn);
    return new vscode.Disposable(() => this.toasts.delete(fn));
  }

  refresh(reason: string): void {
    try {
      const state = this.builder.build({
        conversationId: this.selectedConversation,
        mode: this.mode,
        hooksInstalled: this.hooksInstalled(),
        llmAvailable: this.llmAvailable,
      });
      this.state = state;
      for (const fn of this.listeners) fn(state);
      this.scheduleLlm(state);
    } catch (err) {
      this.output.appendLine(`refresh(${reason}) failed: ${(err as Error).stack ?? err}`);
    }
  }

  private scheduleLlm(state: SessionState): void {
    if (!this.llmAvailable) return;
    this.llmAbort?.abort();
    const abort = new AbortController();
    this.llmAbort = abort;
    void this.builder.enhanceWithLlm(state, abort.signal).then((changed) => {
      if (changed && !abort.signal.aborted) this.refresh('llm-summary');
    });
  }

  private hooksInstalled(): boolean {
    if (fs.existsSync(path.join(LOCAL_PLUGIN_DIR, 'hooks', 'capture-event.mjs'))) return true;
    try {
      const hooks = fs.readFileSync(this.paths.hooksJsonPath, 'utf8');
      if (/decipher/i.test(hooks)) return true;
    } catch {
      /* no user hooks */
    }
    return fs.existsSync(this.paths.eventsDir) && fs.readdirSync(this.paths.eventsDir).length > 0;
  }

  handleMessage(msg: FromWebviewMessage): void {
    switch (msg.type) {
      case 'ready':
      case 'refresh':
        this.refresh(msg.type);
        break;
      case 'selectConversation':
        this.selectedConversation = msg.conversationId;
        this.refresh('select');
        break;
      case 'setMode':
        void vscode.workspace.getConfiguration('decipher').update('mode', msg.mode, vscode.ConfigurationTarget.Global);
        break;
      case 'markConcept': {
        const scored = this.state?.debt?.queue.find((q) => q.concept.id === msg.conceptId);
        this.profile.setStatus(msg.conceptId, msg.status, scored?.debt ?? this.estimateDebt(msg.conceptId));
        break;
      }
      case 'markAllSeen':
        for (const q of this.state?.debt?.queue ?? []) if (q.status === 'new') this.profile.setStatus(q.concept.id, 'learning', 0);
        break;
      case 'termExpanded':
        this.profile.recordTermExpanded(msg.termId);
        break;
      case 'openResource':
        void this.openResource(msg.resource);
        break;
      case 'openFile':
        void this.openFile(msg.path, msg.line);
        break;
      case 'askAgent':
        void this.askAgent(msg.conceptId);
        break;
      case 'exportLearningPlan':
        void this.exportLearningPlan();
        break;
      case 'installHooks':
        void this.installHooks();
        break;
    }
  }

  private estimateDebt(conceptId: string): number {
    const c = this.graph.get(conceptId);
    return c ? (c.depth === 'beginner' ? 4 : c.depth === 'intermediate' ? 8 : 10) : 0;
  }

  private async openResource(resource: Resource): Promise<void> {
    if (resource.url) {
      await vscode.env.openExternal(vscode.Uri.parse(resource.url));
      return;
    }
    if (resource.path) {
      const p = expandHome(resource.path);
      if (fs.existsSync(p)) {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(p));
        await vscode.window.showTextDocument(doc, { preview: true });
      } else {
        void vscode.window.showInformationMessage(`Decipher: that skill is not installed on this machine (${resource.path}).`);
      }
    }
  }

  private async openFile(p: string, line?: number): Promise<void> {
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(p));
      const editor = await vscode.window.showTextDocument(doc, { preview: true });
      if (line) {
        const pos = new vscode.Position(Math.max(0, line - 1), 0);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        editor.selection = new vscode.Selection(pos, pos);
      }
    } catch {
      void vscode.window.showWarningMessage(`Decipher: could not open ${p}`);
    }
  }

  /** Pre-fill a teaching prompt. There is no public API to inject into Cursor's chat, so we copy + try known commands. */
  private async askAgent(conceptId: string): Promise<void> {
    const concept = this.graph.get(conceptId);
    if (!concept) return;
    const evidence = this.state?.debt?.queue.find((q) => q.concept.id === conceptId)?.detected.evidence ?? [];
    const files = [...new Set(evidence.map((e) => e.file).filter(Boolean))].slice(0, 3) as string[];
    const fileHint = files.length ? ` Use the code you just wrote in ${files.map((f) => `\`${path.basename(f)}\``).join(' and ')} as the example.` : '';
    const prompt = `Explain ${concept.label} like I'm new to coding. Start with what problem it solves, then walk through what each part of the code does in plain language, and finish with one thing I could try changing myself.${fileHint}`;
    await vscode.env.clipboard.writeText(prompt);
    const candidates = ['composer.newAgentChat', 'composer.openAgentChat', 'aichat.newchataction', 'workbench.action.chat.open'];
    for (const cmd of candidates) {
      try {
        await vscode.commands.executeCommand(cmd);
        break;
      } catch {
        /* try next */
      }
    }
    void vscode.window.showInformationMessage('Decipher: teaching prompt copied — paste it into the agent chat (Cmd+V).');
    this.toast('Prompt copied to clipboard. Paste it into the chat.');
  }

  async exportLearningPlan(): Promise<void> {
    const state = this.state;
    if (!state?.debt) {
      void vscode.window.showInformationMessage('Decipher: nothing to export yet — no concepts detected in this chat.');
      return;
    }
    const md = this.debt.toMarkdown(state.debt, state.turns.map((t) => t.userRequest ?? '').filter(Boolean));
    const doc = await vscode.workspace.openTextDocument({ content: md, language: 'markdown' });
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  async resetProfile(): Promise<void> {
    const ok = await vscode.window.showWarningMessage('Reset your Decipher learning profile? This forgets which concepts you marked as learned.', { modal: true }, 'Reset');
    if (ok === 'Reset') {
      this.profile.reset();
      this.toast('Learning profile reset.');
    }
  }

  /** Copy the bundled plugin into ~/.cursor/plugins/local so Cursor loads its hooks. */
  async installHooks(): Promise<void> {
    const src = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'plugin').fsPath;
    if (!fs.existsSync(src)) {
      void vscode.window.showErrorMessage('Decipher: bundled plugin not found. Run the extension build first.');
      return;
    }
    try {
      fs.mkdirSync(LOCAL_PLUGIN_DIR, { recursive: true });
      fs.cpSync(src, LOCAL_PLUGIN_DIR, { recursive: true, force: true });
      fs.chmodSync(path.join(LOCAL_PLUGIN_DIR, 'hooks', 'capture-event.mjs'), 0o755);
      const choice = await vscode.window.showInformationMessage('Decipher hooks installed. Reload the window so Cursor picks them up.', 'Reload now', 'Later');
      if (choice === 'Reload now') await vscode.commands.executeCommand('workbench.action.reloadWindow');
      this.refresh('hooks');
    } catch (err) {
      void vscode.window.showErrorMessage(`Decipher: could not install hooks — ${(err as Error).message}`);
    }
  }

  private toast(text: string): void {
    for (const fn of this.toasts) fn(text);
  }

  dispose(): void {
    this.watcher?.stop();
    this.llmAbort?.abort();
    this.listeners.clear();
  }
}

// ---------------------------------------------------------------------------

class ActivityViewProvider implements vscode.WebviewViewProvider {
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: DecipherController,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    const webview = view.webview;
    webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist'), vscode.Uri.joinPath(this.extensionUri, 'media')] };
    webview.html = this.html(webview);

    const post = (msg: ToWebviewMessage) => void webview.postMessage(msg);
    const subs = [
      this.controller.onState((state) => post({ type: 'state', state })),
      this.controller.onToast((text) => post({ type: 'toast', text })),
      webview.onDidReceiveMessage((msg: FromWebviewMessage) => this.controller.handleMessage(msg)),
    ];
    view.onDidDispose(() => subs.forEach((s) => s.dispose()));
  }

  private html(webview: vscode.Webview): string {
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.css'));
    const nonce = [...Array(24)].map(() => Math.floor(Math.random() * 36).toString(36)).join('');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};" />
<link rel="stylesheet" href="${style}" />
<title>Decipher</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

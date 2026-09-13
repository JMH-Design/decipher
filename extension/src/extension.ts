import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { DataSourcePreference, ExplainMode, FromWebviewMessage, HostKind, LoadingPhase, Resource, SessionState, ToWebviewMessage } from '../../shared/activity-schema';
import { LlmSummarizer } from './explainer/llmSummarizer';
import { TemplateEngine } from './explainer/templateEngine';
import { VscodeLmProvider } from './explainer/vscodeLmProvider';
import { GlossaryService } from './glossary/glossaryService';
import { detectHost, HOST_LABEL } from './host/detectHost';
import { resolveStore, type StoreContext, type TranscriptStore } from './host/transcriptStore';
import { KnowledgeGraph } from './knowledge/knowledgeGraph';
import { resolveLoadingPhase } from './loading/resolveLoadingPhase';
import { expandHome } from './paths';
import { RecommendationCatalog } from './research/catalog';
import { ResearchService } from './research/researchService';
import { resourceSheetMarkdown } from './research/resourceSheet';
import { ContextDevSearchClient } from './research/webSearchClient';
import { SessionBuilder } from './session/sessionBuilder';
import { ActivityWatcher } from './session/watcher';

const VIEW_ID = 'decipher.activityView';
const LOCAL_PLUGIN_DIR = path.join(os.homedir(), '.cursor', 'plugins', 'local', 'decipher-hooks');
const CURSOR_HOOKS_JSON = path.join(os.homedir(), '.cursor', 'hooks.json');
/** Secret storage key for the Context.dev token used by live web search. */
const SEARCH_KEY_SECRET = 'decipher.contextDevApiKey';

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
    vscode.commands.registerCommand('decipher.researchNow', () => controller.researchNow()),
    vscode.commands.registerCommand('decipher.setSearchApiKey', () => controller.setSearchApiKey()),
    vscode.commands.registerCommand('decipher.exportResourceSheet', () => controller.exportResourceSheet()),
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
  private readonly host: HostKind;
  private store: TranscriptStore;
  private readonly glossary = new GlossaryService();
  private readonly graph = new KnowledgeGraph();
  private readonly lmProvider = new VscodeLmProvider();
  private readonly search: ContextDevSearchClient;
  private engine: TemplateEngine;
  private llm: LlmSummarizer;
  private research: ResearchService;
  private builder: SessionBuilder;
  private watcher: ActivityWatcher | undefined;
  private state: SessionState | undefined;
  private selectedConversation: string | null = null;
  private llmAvailable = false;
  private webSearchConfigured = false;
  private asyncAbort: AbortController | undefined;
  /** Guards against a stale enrichment pass publishing over a newer build. */
  private generation = 0;
  private readonly listeners = new Set<(s: SessionState) => void>();
  private readonly toasts = new Set<(t: string) => void>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly workspaceRoot: string,
    private readonly output: vscode.OutputChannel,
  ) {
    this.host = detectHost(vscode.env.appName);
    this.store = resolveStore(this.storeContext());
    this.engine = new TemplateEngine({ glossary: this.glossary, workspaceRoot });
    this.llm = new LlmSummarizer(this.lmProvider, this.llmOptions());
    this.search = new ContextDevSearchClient(async () => this.context.secrets.get(SEARCH_KEY_SECRET));
    this.research = this.makeResearch();
    this.builder = this.makeBuilder();
    output.appendLine(`Host: ${HOST_LABEL[this.host]} · reading ${this.store.label} from ${this.store.location}`);
  }

  private config<T>(key: string): T | undefined {
    return vscode.workspace.getConfiguration('decipher').get<T>(key);
  }

  private storeContext(): StoreContext {
    return {
      host: this.host,
      workspacePath: this.workspaceRoot,
      preference: this.config<DataSourcePreference>('dataSource') ?? 'auto',
      storageDir: this.context.globalStorageUri.fsPath,
      // `cursorProjectsDir` predates multi-host support and is kept as an alias.
      cursorProjectsDir: this.config<string>('projectsDirOverride') || this.config<string>('cursorProjectsDir') || undefined,
      claudeConfigDir: this.config<string>('claudeConfigDir') || undefined,
    };
  }

  private llmOptions() {
    return {
      enabled: this.config<boolean>('llm.enabled') ?? true,
      alwaysExplainInDepth: this.config<boolean>('llm.alwaysExplainInDepth') ?? false,
    };
  }

  private researchOptions() {
    return {
      enabled: this.config<boolean>('research.enabled') ?? true,
      webSearch: this.config<boolean>('research.webSearch') ?? true,
      trigger: this.config<'auto' | 'manual'>('research.trigger') ?? 'auto',
      maxResults: this.config<number>('research.maxResults') ?? 6,
    };
  }

  private makeResearch(): ResearchService {
    return new ResearchService({
      catalog: new RecommendationCatalog(),
      provider: this.lmProvider,
      search: this.search,
      cacheDir: this.store.researchDir,
      options: this.researchOptions(),
      log: (m) => this.output.appendLine(m),
    });
  }

  private makeBuilder(): SessionBuilder {
    return new SessionBuilder({
      store: this.store,
      workspaceName: path.basename(this.workspaceRoot),
      engine: this.engine,
      glossary: this.glossary,
      graph: this.graph,
      llm: this.llm,
      research: this.research,
    });
  }

  start(): void {
    this.startWatching();
    void this.search.isConfigured().then((ok) => {
      this.webSearchConfigured = ok;
      this.refresh('search-key');
    });
    void this.llm.isAvailable().then((ok) => {
      this.llmAvailable = ok;
      this.output.appendLine(`Language model ${ok ? 'available' : 'unavailable'} — ${ok ? 'turn summaries and recommendations will be richer' : 'using templates and the built-in catalog only'}.`);
      this.refresh('llm');
    });
    this.refresh('start');
  }

  private startWatching(): void {
    // Gates the "Install Cursor hooks" command so it never shows up where it cannot work.
    void vscode.commands.executeCommand('setContext', 'decipher.hooksSupported', this.store.hooksSupported);
    this.watcher?.stop();
    // Only Cursor's directories are ours to create; another agent's are watched as-is.
    this.watcher = new ActivityWatcher(this.store.watchDirs, () => this.refresh('watch'), 250, this.store.provider === 'cursor');
    this.watcher.start();
  }

  reloadConfig(): void {
    this.rewire(resolveStore(this.storeContext()));
    this.llm.setOptions(this.llmOptions());
    this.start();
  }

  /**
   * Point the pipeline at a transcript source. Both the research cache and the session
   * builder are tied to the store, so swapping one means rebuilding both. Callers restart
   * the watcher and refresh.
   */
  private rewire(store: TranscriptStore): void {
    this.store = store;
    this.output.appendLine(`Reading ${store.label} from ${store.location}`);
    this.research = this.makeResearch();
    this.builder = this.makeBuilder();
  }

  get mode(): ExplainMode {
    return this.config<ExplainMode>('mode') ?? 'beginner';
  }

  /** Latest session snapshot, for re-publishing when the sidebar becomes visible again. */
  currentState(): SessionState | undefined {
    return this.state;
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

  /**
   * Build synchronously, then decide whether the panel is ready to be seen. The webview keeps
   * its cards hidden behind the loader until `loadingPhase: 'ready'`, so it never reveals a
   * timeline that is still growing.
   */
  refresh(reason: string): void {
    const generation = ++this.generation;
    try {
      this.adoptStoreIfSourceAppeared();
      const state = this.builder.build({
        conversationId: this.selectedConversation,
        mode: this.mode,
        host: this.host,
        hooksInstalled: this.hooksInstalled(),
        llmAvailable: this.llmAvailable,
        webSearchConfigured: this.webSearchConfigured,
        loadingRotateMs: this.config<number>('loading.rotateMs') ?? 3500,
      });
      const pendingLlm = this.llmAvailable && this.builder.pendingLlmTurns(state) > 0;
      const pendingResearch = this.research.shouldResearch(state);
      const phase: LoadingPhase = resolveLoadingPhase(state.turns, { llm: pendingLlm, research: pendingResearch });
      this.publish({ ...state, loadingPhase: phase });
      const turnActive = state.turns[state.turns.length - 1]?.status === 'active';
      if (!turnActive && (pendingLlm || pendingResearch)) void this.enrich(generation, state, pendingLlm, pendingResearch);
    } catch (err) {
      this.output.appendLine(`refresh(${reason}) failed: ${(err as Error).stack ?? err}`);
      // Never leave the webview stuck behind the loader.
      if (this.state) this.publish({ ...this.state, loadingPhase: 'ready' });
    }
  }

  /**
   * The first chat of a session can arrive after Decipher starts, and it may belong to a
   * different agent than the one we guessed. Re-resolving while empty costs two directory
   * listings and saves the user a window reload.
   */
  private adoptStoreIfSourceAppeared(): void {
    if (this.store.list().some((s) => s.hasMessages)) return;
    const resolved = resolveStore(this.storeContext());
    if (resolved.provider === this.store.provider) return;
    this.rewire(resolved);
    this.startWatching();
  }

  private publish(state: SessionState): void {
    this.state = state;
    for (const fn of this.listeners) fn(state);
  }

  private async enrich(generation: number, state: SessionState, pendingLlm: boolean, pendingResearch: boolean): Promise<void> {
    this.asyncAbort?.abort();
    const abort = new AbortController();
    this.asyncAbort = abort;
    // allSettled: a failure in one pass must not strand the other, or the loader never clears.
    await Promise.allSettled([
      pendingLlm ? this.builder.enhanceWithLlm(state, abort.signal) : Promise.resolve(false),
      pendingResearch ? this.builder.enhanceWithResearch(state, abort.signal) : Promise.resolve(false),
    ]);
    if (abort.signal.aborted || generation !== this.generation) return;
    // Both passes cache their outcome, so this rebuild finds nothing pending and lands on 'ready'.
    this.refresh('enriched');
  }

  /** Hooks are a Cursor plugin. Everywhere else the answer is "not applicable", not "missing". */
  private hooksInstalled(): boolean {
    if (!this.store.hooksSupported) return false;
    if (fs.existsSync(path.join(LOCAL_PLUGIN_DIR, 'hooks', 'capture-event.mjs'))) return true;
    try {
      if (/decipher/i.test(fs.readFileSync(CURSOR_HOOKS_JSON, 'utf8'))) return true;
    } catch {
      /* no user hooks */
    }
    const eventsDir = this.store.eventsDir;
    return Boolean(eventsDir) && fs.existsSync(eventsDir!) && fs.readdirSync(eventsDir!).length > 0;
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
      case 'openResource':
        void this.openResource(msg.resource);
        break;
      case 'openFile':
        void this.openFile(msg.path, msg.line);
        break;
      case 'researchNow':
        this.researchNow();
        break;
      case 'configureWebSearch':
        void this.setSearchApiKey();
        break;
      case 'exportResourceSheet':
        void this.exportResourceSheet();
        break;
      case 'installHooks':
        void this.installHooks();
        break;
    }
  }

  /** Drop the cached result for this chat so the next build researches again. */
  researchNow(): void {
    const id = this.state?.conversationId;
    if (!id) {
      void vscode.window.showInformationMessage('Decipher: pick a chat first.');
      return;
    }
    this.research.requestNow(id);
    this.refresh('research-now');
  }

  /**
   * Context.dev token for live search. Stored in the editor's secret storage — never in
   * settings JSON, the workspace, or the webview.
   */
  async setSearchApiKey(): Promise<void> {
    const existing = await this.context.secrets.get(SEARCH_KEY_SECRET);
    const value = await vscode.window.showInputBox({
      title: 'Decipher — Context.dev API key',
      prompt: 'Paste a Context.dev API key to let Decipher search the live web for tools. Leave blank to remove the stored key.',
      placeHolder: existing ? 'A key is already stored — type a new one, or leave blank to remove it' : 'ctxt_secret_…',
      password: true,
      ignoreFocusOut: true,
    });
    if (value === undefined) return;

    const trimmed = value.trim();
    if (trimmed) {
      await this.context.secrets.store(SEARCH_KEY_SECRET, trimmed);
      this.toast('Context.dev key saved. Live web search is on.');
    } else {
      await this.context.secrets.delete(SEARCH_KEY_SECRET);
      this.toast('Context.dev key removed. Suggestions will use the built-in catalog.');
    }
    this.webSearchConfigured = await this.search.isConfigured();
    if (this.state?.conversationId) this.research.invalidate(this.state.conversationId);
    this.refresh('search-key');
  }

  async exportResourceSheet(): Promise<void> {
    const state = this.state;
    if (!state?.conversationId || (!state.sessionConcepts.length && !state.recommendations.length)) {
      void vscode.window.showInformationMessage('Decipher: nothing to export yet — no concepts or suggestions for this chat.');
      return;
    }
    const doc = await vscode.workspace.openTextDocument({ content: resourceSheetMarkdown(state), language: 'markdown' });
    await vscode.window.showTextDocument(doc, { preview: false });
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

  /** Copy the bundled plugin into ~/.cursor/plugins/local so Cursor loads its hooks. */
  async installHooks(): Promise<void> {
    if (!this.store.hooksSupported) {
      void vscode.window.showInformationMessage(
        `Decipher: hooks are a Cursor plugin, and ${HOST_LABEL[this.host]} has no equivalent yet. Step cards still work — only tool output, durations, and exit codes are missing.`,
      );
      return;
    }
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
    this.asyncAbort?.abort();
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
      view.onDidChangeVisibility(() => {
        post({ type: view.visible ? 'viewVisible' : 'viewHidden' });
        if (view.visible) {
          const state = this.controller.currentState();
          if (state) post({ type: 'state', state });
        }
      }),
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

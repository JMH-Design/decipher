import * as vscode from 'vscode';
import type { LlmProvider } from './llmSummarizer';

/**
 * Uses the editor's Language Model API (`vscode.lm`) when the host exposes it.
 * No API keys, nothing leaves the editor's existing model channel. If the host
 * (or the user's consent dialog) declines, the summarizer silently falls back to templates.
 */
export class VscodeLmProvider implements LlmProvider {
  private model: vscode.LanguageModelChat | undefined;

  async available(): Promise<boolean> {
    const lm = (vscode as unknown as { lm?: typeof vscode.lm }).lm;
    if (!lm || typeof lm.selectChatModels !== 'function') return false;
    try {
      const models = await lm.selectChatModels({});
      this.model = models[0];
      return Boolean(this.model);
    } catch {
      return false;
    }
  }

  async complete(system: string, user: string, signal?: AbortSignal): Promise<string | undefined> {
    if (!this.model && !(await this.available())) return undefined;
    const model = this.model!;
    const cts = new vscode.CancellationTokenSource();
    signal?.addEventListener('abort', () => cts.cancel());
    const timer = setTimeout(() => cts.cancel(), 20_000);
    try {
      const messages = [vscode.LanguageModelChatMessage.User(`${system}\n\n---\n\n${user}`)];
      const response = await model.sendRequest(messages, {}, cts.token);
      let text = '';
      for await (const chunk of response.text) text += chunk;
      return text.trim() || undefined;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
      cts.dispose();
    }
  }
}

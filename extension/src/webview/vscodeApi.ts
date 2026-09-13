import type { FromWebviewMessage, ToWebviewMessage } from '../../../shared/activity-schema';

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const api: VsCodeApi | undefined = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined;

export function post(msg: FromWebviewMessage): void {
  api?.postMessage(msg);
}

export function onMessage(handler: (msg: ToWebviewMessage) => void): () => void {
  const listener = (e: MessageEvent<ToWebviewMessage>) => handler(e.data);
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}

export function getUiState<T>(): T | undefined {
  return api?.getState<T>();
}

export function setUiState<T>(state: T): void {
  api?.setState(state);
}

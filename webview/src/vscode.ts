import type { WebviewMessage } from '../../src/shared/protocol';

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const api: VsCodeApi =
  typeof acquireVsCodeApi === 'function'
    ? acquireVsCodeApi()
    : {
        postMessage: () => undefined,
        getState: () => undefined,
        setState: () => undefined,
      };

export const vscode = api;

export function post(message: WebviewMessage): void {
  vscode.postMessage(message);
}

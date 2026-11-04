// Types for the parts of browser.mjs the extension imports.
export const record: string;
export const activity: string;
export function touch(file?: string): void;
export type IdleResult = { status: 'disabled' | 'not_started' | 'not_running' | 'in_use' | 'refused' | 'closed_idle'; [key: string]: unknown };
export function closeIdle(file: string | undefined, used: string | undefined, idleMs: number, io?: {
  now?: number;
  probe?: (endpoint: string) => Promise<{ webSocketDebuggerUrl: string }>;
  close?: (ws: string) => Promise<void>;
  closed?: (endpoint: string) => Promise<void>;
}): Promise<IdleResult>;

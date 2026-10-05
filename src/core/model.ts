export type Provider = 'codex' | 'claude';
export type Status = 'idle' | 'running' | 'completed' | 'error' | 'cancelled' | 'waitingForInput' | 'unknown';
export type TerminalStatus = 'completed' | 'error' | 'cancelled';
export interface SessionBinding {
  windowInstanceId: string; provider: Provider; runtimeId: string;
  connectionId: string; sessionId: string; source: 'ownedExecution' | 'verifiedIntegration';
}
export interface InputRequest {
  id: string; turnId: string; connectionId: string; title: string;
  kind: 'approval' | 'question'; payload: unknown;
}
export interface TurnState { id: string; status: Status; text: string; truncated: boolean; resultId?: string }
export interface Signal extends SessionBinding {
  notificationId: string; turnId: string; status: Status; text: string; truncated: boolean;
  requestId?: string; detail?: string; at: string;
  scope?: 'turn' | 'startRequest';
}
export interface Checkpoint {
  version: 1; completed: [string, TerminalStatus][]; turns: TurnState[];
  pendingStart?: string;
}
export const LIMITS = { messageBytes: 1024 * 1024, queueCount: 512, queueBytes: 4 * 1024 * 1024,
  results: 20, textBytes: 16 * 1024, diagnostics: 100, dedup: 512, turns: 32, requests: 128 } as const;
export function boundedText(text: string, limit = LIMITS.textBytes): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text);
  if (bytes.length <= limit) return { text, truncated: false };
  let end = limit;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(0, end).toString('utf8'), truncated: true };
}
export function toastText(text: string): string { const chars = Array.from(text); return chars.length > 180 ? chars.slice(0, 179).join('') + '…' : text; }
export const sessionKey = (b: Pick<SessionBinding, 'provider' | 'runtimeId' | 'sessionId'>): string => JSON.stringify([b.provider, b.runtimeId, b.sessionId]);
export const isTerminal = (s: Status): s is TerminalStatus => s === 'completed' || s === 'error' || s === 'cancelled';

export class Diagnostics {
  readonly entries: { at: string; message: string }[] = [];
  add(message: unknown): void {
    this.entries.push({ at: new Date().toISOString(), message: boundedText(String(message), 2048).text });
    if (this.entries.length > LIMITS.diagnostics) this.entries.shift();
  }
}

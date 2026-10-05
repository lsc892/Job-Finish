import type { Turn } from '../protocol/v2/Turn';
import { Session } from '../core/session';
import { TerminalStatus } from '../core/model';
import { RpcMessage } from './transport';

export function codexStatus(value: string): TerminalStatus | undefined {
  switch (value) { case 'completed': return 'completed'; case 'failed': return 'error'; case 'interrupted': return 'cancelled'; default: return undefined; }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed Codex object');
  return value as Record<string, unknown>;
}
function id(value: unknown): string { if (typeof value !== 'string' || !value) throw new Error('Missing Codex identifier'); return value; }

/** Shared by live execution and protocol fixture verification. */
export class CodexAdapter {
  constructor(readonly session: Session) {}
  handle(message: RpcMessage, connectionId: string, admitStarted = false): void {
    if (!this.session.valid(connectionId)) return;
    const methods = ['turn/started', 'turn/completed', 'item/completed', 'error'];
    if (!methods.includes(message.method ?? '')) return;
    const p = object(message.params);
    if (id(p.threadId) !== this.session.binding.sessionId) return;
    if (message.method === 'turn/started') {
      const turn = object(p.turn);
      if (admitStarted) this.session.start(id(turn.id), connectionId);
      else this.session.running(id(turn.id), connectionId);
    } else if (message.method === 'item/completed') {
      const item = object(p.item);
      if (item.type === 'agentMessage' && item.phase !== 'commentary') {
        if (typeof item.text !== 'string') throw new Error('Malformed agent message');
        this.session.body(id(p.turnId), item.text, connectionId);
      }
    } else if (message.method === 'turn/completed') {
      this.reconcileTurn(p.turn as Turn, connectionId);
    } else if (message.method === 'error') {
      this.session.diagnostics.add(`Codex non-terminal error: ${JSON.stringify(p.error)}`);

    }
  }
  reconcileTurn(value: Turn, connectionId: string): void {
    const turn = object(value); const turnId = id(turn.id);
    const status = codexStatus(String(turn.status));
    if (!status) {
      if (turn.status !== 'inProgress') throw new Error(`Unknown Codex turn status: ${turn.status}`);
      this.session.running(turnId, connectionId); return;
    }
    if (Array.isArray(turn.items)) for (const item of turn.items) {
      const entry = object(item);
      if (entry.type === 'agentMessage' && entry.phase !== 'commentary' && typeof entry.text === 'string') this.session.body(turnId, entry.text, connectionId);
    }
    let detail: string | undefined;
    if (turn.error) {
      const error = object(turn.error);
      const code = typeof error.codexErrorInfo === 'string' ? error.codexErrorInfo : JSON.stringify(error.codexErrorInfo);
      detail = `${code || 'Codex error'}: ${typeof error.message === 'string' ? error.message : 'No error message received'}`;
    }
    this.session.finish(turnId, status, connectionId, detail);
  }
}

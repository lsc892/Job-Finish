import type { Turn } from '../../protocol/v2/Turn';
import type { PermissionsRequestApprovalParams } from '../../protocol/v2/PermissionsRequestApprovalParams';
import type { PermissionsRequestApprovalResponse } from '../../protocol/v2/PermissionsRequestApprovalResponse';
import { Session } from '../../core/session';
import type { TerminalStatus } from '../../core/model';
import type { RpcMessage } from '../transport';

export function codexStatus(value: string): TerminalStatus | undefined {
  switch (value) {
    case 'completed': return 'completed';
    case 'failed': return 'error';
    case 'interrupted': return 'cancelled';
    default: return undefined;
  }
}

export function codexObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed Codex object');
  return value as Record<string, unknown>;
}

export function codexId(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('Missing Codex identifier');
  return value;
}

export function codexApprovalResponse(message: RpcMessage, allow: boolean): unknown {
  if (message.method === 'item/permissions/requestApproval') {
    const { permissions } = message.params as PermissionsRequestApprovalParams;
    codexObject(permissions);
    return { scope: 'turn', permissions: allow ? {
      ...(permissions.network ? { network: permissions.network } : {}),
      ...(permissions.fileSystem ? { fileSystem: permissions.fileSystem } : {}),
    } : {} } satisfies PermissionsRequestApprovalResponse;
  }
  return { decision: allow ? 'accept' : 'decline' };
}

/** Converts Codex protocol events to Session updates for owned and observed executions. */
export class CodexAdapter {
  constructor(readonly session: Session) {}

  handle(message: RpcMessage, connectionId: string, admitStarted = false): void {
    if (!this.session.valid(connectionId)) return;
    const methods = ['turn/started', 'turn/completed', 'item/completed', 'serverRequest/resolved', 'error',
      'item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput'];
    if (!methods.includes(message.method ?? '')) return;
    const params = codexObject(message.params);
    if (codexId(params.threadId) !== this.session.binding.sessionId) return;
    switch (message.method) {
      case 'turn/started': {
        const turn = codexObject(params.turn);
        if (admitStarted) this.session.start(codexId(turn.id), connectionId);
        else this.session.running(codexId(turn.id), connectionId);
        return;
      }
      case 'item/completed': {
        const item = codexObject(params.item);
        if (item.type !== 'agentMessage' || item.phase === 'commentary') return;
        if (typeof item.text !== 'string') throw new Error('Malformed agent message');
        this.session.body(codexId(params.turnId), item.text, connectionId);
        return;
      }
      case 'turn/completed':
        this.reconcileTurn(params.turn as Turn, connectionId);
        return;
      case 'serverRequest/resolved':
        this.session.resolve(JSON.stringify(params.requestId), connectionId);
        return;
      case 'error':
        this.session.diagnostics.add(`Codex non-terminal error: ${JSON.stringify(params.error)}`);
        return;
      default:
        this.requestInput(message, params, connectionId);
    }
  }

  private requestInput(message: RpcMessage, params: Record<string, unknown>, connectionId: string): void {
    if (message.id === undefined) return;
    const turnId = codexId(params.turnId);
    const question = message.method === 'item/tool/requestUserInput';
    this.session.waiting({ id: JSON.stringify(message.id), turnId, connectionId,
      kind: question ? 'question' : 'approval', payload: message,
      title: question ? JSON.stringify(params.questions) : String(params.command ?? params.reason ?? 'File change approval') });
  }

  reconcileTurn(value: Turn, connectionId: string): void {
    const turn = codexObject(value);
    const turnId = codexId(turn.id);
    const status = codexStatus(String(turn.status));
    if (!status) {
      if (turn.status !== 'inProgress') throw new Error(`Unknown Codex turn status: ${turn.status}`);
      this.session.running(turnId, connectionId);
      return;
    }
    if (Array.isArray(turn.items)) for (const item of turn.items) {
      const entry = codexObject(item);
      if (entry.type === 'agentMessage' && entry.phase !== 'commentary' && typeof entry.text === 'string') this.session.body(turnId, entry.text, connectionId);
    }
    let detail: string | undefined;
    if (turn.error) {
      const error = codexObject(turn.error);
      const code = typeof error.codexErrorInfo === 'string' ? error.codexErrorInfo : JSON.stringify(error.codexErrorInfo);
      detail = `${code || 'Codex error'}: ${typeof error.message === 'string' ? error.message : 'No error message received'}`;
    }
    this.session.finish(turnId, status, connectionId, detail);
  }
}

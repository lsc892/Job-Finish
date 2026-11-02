// Codex 턴 종료·승인·질문 이벤트를 공통 세션 상태로 변환한다.
import type { Turn } from '../../protocol/v2/Turn';
import type { PermissionsRequestApprovalParams } from '../../protocol/v2/PermissionsRequestApprovalParams';
import type { PermissionsRequestApprovalResponse } from '../../protocol/v2/PermissionsRequestApprovalResponse';
import { Session } from '../../core/session';
import type { TerminalStatus } from '../../core/model';
import type { RpcMessage } from '../transport';
import { record } from '../message';

const SESSION_EVENT_METHODS: readonly string[] = [
  'thread/name/updated', 'turn/started', 'turn/completed', 'item/completed', 'serverRequest/resolved', 'error',
  'item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
  'item/permissions/requestApproval', 'item/tool/requestUserInput',
];

// completed·failed·interrupted를 완료·오류·취소로 변환한다.
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
  if (message.method !== 'item/permissions/requestApproval') return { decision: allow ? 'accept' : 'decline' };

  const { permissions } = message.params as PermissionsRequestApprovalParams;
  codexObject(permissions);
  return {
    scope: 'turn',
    permissions: allow ? {
      ...(permissions.network ? { network: permissions.network } : {}),
      ...(permissions.fileSystem ? { fileSystem: permissions.fileSystem } : {}),
    } : {},
  } satisfies PermissionsRequestApprovalResponse;
}

/** 소유·관찰 실행의 Codex 프로토콜 이벤트를 공통 세션 상태로 변환한다. */
export class CodexAdapter {
  constructor(readonly session: Session) {}

  handle(message: RpcMessage, connectionId: string, admitStarted = false): void {
    if (!this.session.valid(connectionId)) return;
    if (!SESSION_EVENT_METHODS.includes(message.method ?? '')) return;
    const params = codexObject(message.params);
    if (codexId(params.threadId) !== this.session.binding.sessionId) return;
    switch (message.method) {
      case 'thread/name/updated':
        this.session.setTitle(params.threadName, connectionId);
        return;
      case 'turn/started': {
        const turn = codexObject(params.turn);
        const turnId = codexId(turn.id);
        if (admitStarted) this.session.start(turnId, connectionId);
        else this.session.running(turnId, connectionId);
        return;
      }
      case 'item/completed': {
        // 비동기 질문은 알리고 최종 응답은 보관하되 턴 종료는 turn/completed에서 확정한다.
        const item = codexObject(params.item);
        if (item.type !== 'agentMessage') return;
        // request_user_input_async는 별도 서버 요청 없이 질문을 담은 메시지로 전달된다.
        const questions = Array.isArray(item.questions) ? item.questions.map(record)
          .map(question => question?.title).filter((title): title is string => typeof title === 'string' && title.trim().length > 0) : [];
        if (questions.length) {
          this.session.notifyQuestion(codexId(params.turnId), codexId(item.id), questions.join('\n'), connectionId);
          return;
        }
        if (item.phase === 'commentary') return;
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
        // 승인·질문 요청을 요청 ID와 턴 ID에 연결해 입력 대기로 전환한다.
        if (message.id === undefined) return;
        const turnId = codexId(params.turnId);
        const isQuestion = message.method === 'item/tool/requestUserInput';
        this.session.waiting({
          id: JSON.stringify(message.id),
          turnId,
          connectionId,
          kind: isQuestion ? 'question' : 'approval',
          payload: message,
          title: isQuestion
            ? JSON.stringify(params.questions)
            : String(params.command ?? params.reason ?? 'File change approval'),
        });
    }
  }

  // 명시적 턴 상태를 확인하고 최종 본문·오류 설명을 반영한 뒤 종료한다.
  reconcileTurn(value: Turn, connectionId: string): void {
    const turn = codexObject(value);
    const turnId = codexId(turn.id);
    const status = codexStatus(String(turn.status));
    if (!status) {
      if (turn.status !== 'inProgress') throw new Error(`Unknown Codex turn status: ${turn.status}`);
      this.session.running(turnId, connectionId);
      return;
    }
    if (Array.isArray(turn.items)) {
      for (const item of turn.items) {
        const entry = codexObject(item);
        if (entry.type !== 'agentMessage' || entry.phase === 'commentary' || typeof entry.text !== 'string'
          || (Array.isArray(entry.questions) && entry.questions.length > 0)) continue;
        this.session.body(turnId, entry.text, connectionId);
      }
    }
    let detail: string | undefined;
    if (turn.error) {
      const error = codexObject(turn.error);
      const code = typeof error.codexErrorInfo === 'string' ? error.codexErrorInfo : JSON.stringify(error.codexErrorInfo);
      const message = typeof error.message === 'string' ? error.message : 'No error message received';
      detail = `${code || 'Codex error'}: ${message}`;
    }
    this.session.finish(turnId, status, connectionId, detail);
  }
}

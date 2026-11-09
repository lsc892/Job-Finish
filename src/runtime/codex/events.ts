// 관찰한 Codex 실시간 이벤트를 해석하고 임시·하위 스레드를 제외해 세션에 반영한다.
import type { AgentEvents, EventContext } from '../agent-provider';
import { LIMITS, sessionTitleText, TerminalStatus } from '../../core/model';
import type { Session } from '../../core/session';
import { bound, identifier, record } from '../message';
import { CodexThreadDiagnostics } from './thread-diagnostics';
import { isExcludedCodexThread } from './thread-metadata';

const SESSION_EVENT_METHODS: readonly string[] = [
  'turn/started', 'turn/completed', 'item/started', 'item/completed', 'serverRequest/resolved', 'error',
  'item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
  'item/permissions/requestApproval', 'item/tool/requestUserInput',
];

// completed·failed·interrupted를 완료·오류·취소로 변환한다.
function codexStatus(value: string): TerminalStatus | undefined {
  switch (value) {
    case 'completed': return 'completed';
    case 'failed': return 'error';
    case 'interrupted': return 'cancelled';
    default: return undefined;
  }
}

function codexObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed Codex object');
  return value as Record<string, unknown>;
}

function codexId(value: unknown): string {
  const id = identifier(value);
  if (!id) throw new Error('Missing or oversized Codex identifier');
  return id;
}

interface CodexSessionEvent {
  message: Record<string, unknown>;
  params: Record<string, unknown>;
  item?: Record<string, unknown>;
  questionText?: string;
}

// 지원하는 실시간 이벤트만 해석하며 이력 응답은 알림으로 변환하지 않는다.
function codexSessionEvent(message: Record<string, unknown>): CodexSessionEvent | undefined {
  if (typeof message.method !== 'string' || !SESSION_EVENT_METHODS.includes(message.method)) return;
  const params = codexObject(message.params);
  codexId(params.threadId);
  let item: Record<string, unknown> | undefined;
  let questionText: string | undefined;
  if (message.method === 'item/started' || message.method === 'item/completed') {
    item = message.method === 'item/started' ? record(params.item) : codexObject(params.item);
    if (item?.type === 'agentMessage' && Array.isArray(item.questions)) {
      const titles = item.questions.map(record).map(question => question?.title)
        .filter((title): title is string => typeof title === 'string' && title.trim().length > 0);
      if (titles.length) questionText = titles.join('\n');
    }
    if (message.method === 'item/started' && !questionText) return;
  }
  return { message, params, item, questionText };
}


/** 관찰한 Codex 연결에서 알림 대상 스레드를 선별하고 실시간 이벤트를 세션에 반영한다. */
export class CodexEvents implements AgentEvents {
  // thread/start 요청 ID별 임시 스레드 여부를 응답까지 보관한다.
  private readonly pendingThreadStarts = new Map<string, boolean>();
  private readonly excludedThreads = new Set<string>();
  private readonly titles = new Map<string, { name?: string; preview?: string }>();
  private readonly threadDiagnostics: CodexThreadDiagnostics;
  constructor(private readonly context: EventContext) {
    diagnostic: this.threadDiagnostics = new CodexThreadDiagnostics(context.trace, this.excludedThreads);
  }

  outgoing(message: Record<string, unknown>): void {
    diagnostic: this.threadDiagnostics.outgoing(message);
    switch (message.method) {
      case 'thread/start': {
        if (message.id === undefined) return;
        const params = record(message.params);
        this.pendingThreadStarts.set(JSON.stringify(message.id), params?.ephemeral === true);
        bound(this.pendingThreadStarts);
        return;
      }
      case 'turn/start': {
        const params = record(message.params);
        const id = identifier(params?.threadId);
        if (!id || this.excludedThreads.has(id) || !Array.isArray(params?.input)) return;
        const prompt = params.input
          .map(record)
          .filter(item => item?.type === 'text' && typeof item.text === 'string')
          .map(item => item!.text)
          .join(' ');
        this.rememberTitle(id, undefined, prompt);
      }
    }
  }

  incoming(message: Record<string, unknown>): void {
    const params = record(message.params);
    const result = record(message.result);
    const thread = record(params?.thread ?? result?.thread);
    // 임시·하위 스레드를 제외하고 이력은 제목에만, 실시간 이벤트는 턴 상태에 반영한다.
    const pendingKey = message.method === undefined ? JSON.stringify(message.id) : undefined;
    if (thread) this.recordThread(thread, pendingKey ? this.pendingThreadStarts.get(pendingKey) : false);
    if (pendingKey) this.pendingThreadStarts.delete(pendingKey);
    if (Array.isArray(result?.data)) {
      for (const item of result.data) {
        const entry = record(item);
        if (entry) this.recordThread(entry);
      }
    }
    // 하위 스레드 메타데이터가 오지 않아도 생성 활동으로 자식을 먼저 제외한다.
    if (message.method === 'item/started' || message.method === 'item/completed') {
      this.recordSubagentItem(record(params?.item), params);
    }
    if (message.method === 'turn/started' || message.method === 'turn/completed') {
      const items = record(params?.turn)?.items;
      if (Array.isArray(items)) for (const item of items) this.recordSubagentItem(record(item), params);
    }
    diagnostic: this.threadDiagnostics.incoming(message);
    if (message.method === 'thread/name/updated' && params) {
      this.recordTitle({ id: params.threadId, name: params.threadName });
      return;
    }

    if (typeof message.method !== 'string' || !params) return;
    const id = identifier(params.threadId);
    if (!id) return;
    diagnostic: this.threadDiagnostics.turn(message, params);
    if (this.excludedThreads.has(id)) return;
    const event = codexSessionEvent(message);
    if (!event) return;
    const session = this.context.session(id);
    if (!session) return;
    this.applyTitle(session, id);
    const turn = record(params.turn);
    const turnId = identifier(turn?.id ?? params.turnId);
    // A live completion or input request also identifies a turn already running when observation began.
    // Unlike an RPC history response, this comes directly from this window's active runtime connection.
    if (turnId && message.method !== 'error') session.start(turnId, this.context.connectionId);
    this.apply(session, event);
  }

  private recordThread(thread: Record<string, unknown>, pendingEphemeral = false): void {
    if (isExcludedCodexThread(thread) || pendingEphemeral) this.excludeThread(thread.id, 'thread-metadata');
    this.recordTitle(thread);
  }

  private recordSubagentItem(item: Record<string, unknown> | undefined, params: Record<string, unknown> | undefined): void {
    const parentThreadId = identifier(params?.threadId);
    if (!parentThreadId || !item) return;
    // 메시지 교환(interacted)의 상대는 부모·형제일 수도 있으므로 생성만 제외 근거로 쓴다.
    const ids = item.type === 'subAgentActivity' && item.kind === 'started' ? [item.agentThreadId]
      : item.type === 'collabAgentToolCall' && item.tool === 'spawnAgent' && Array.isArray(item.receiverThreadIds)
        ? item.receiverThreadIds : [];
    for (const value of ids) {
      if (value !== parentThreadId) this.excludeThread(value, 'subagent-activity', { parentThreadId, itemType: item.type });
    }
  }

  private excludeThread(value: unknown, reason: string, fields: Record<string, unknown> = {}): void {
    const id = identifier(value);
    if (!id || this.excludedThreads.has(id)) return;
    this.excludedThreads.add(id);
    this.titles.delete(id);
    diagnostic: this.context.trace('codex.thread.excluded', { sessionId: id, reason, ...fields });
    diagnostic: if (this.excludedThreads.size > LIMITS.dedup) this.context.trace('codex.thread.exclusion.evicted', {
      sessionId: this.excludedThreads.values().next().value, reason: 'capacity' });
    bound(this.excludedThreads);
  }

  private recordTitle(thread: Record<string, unknown>): void {
    const id = identifier(thread.id);
    if (!id || this.excludedThreads.has(id)) return;
    if (isExcludedCodexThread(thread)) return;
    this.rememberTitle(id, thread.name, thread.preview);
  }

  private rememberTitle(id: string, name: unknown, preview: unknown): void {
    const title = sessionTitleText(name);
    const fallback = sessionTitleText(preview);
    if (!title && !fallback) return;
    const previous = this.titles.get(id);
    this.titles.set(id, { name: title ?? previous?.name, preview: previous?.preview ?? fallback });
    bound(this.titles);
    const session = this.context.existingSession(id);
    if (session) this.applyTitle(session, id);
  }

  private applyTitle(session: Session, id: string): void {
    const title = this.titles.get(id);
    session.setTitle(title?.name, this.context.connectionId);
    session.setTitle(title?.preview, this.context.connectionId, true);
  }

  private apply(session: Session, event: CodexSessionEvent): void {
    const connectionId = this.context.connectionId;
    if (!session.valid(connectionId)) return;
    const { message, params, item, questionText } = event;
    if (codexId(params.threadId) !== session.binding.sessionId) return;
    switch (message.method) {
      case 'turn/started': return;
      case 'item/started':
      case 'item/completed': {
        // 비동기 질문은 알리고 최종 응답은 보관하되 턴 종료는 turn/completed에서 확정한다.
        if (item?.type !== 'agentMessage') return;
        // request_user_input_async는 별도 서버 요청 없이 질문을 담은 메시지로 전달된다.
        if (questionText) {
          session.notifyQuestion(codexId(params.turnId), codexId(item.id), questionText, connectionId);
          return;
        }
        if (message.method === 'item/started' || item.phase === 'commentary') return;
        if (typeof item.text !== 'string') throw new Error('Malformed agent message');
        session.body(codexId(params.turnId), item.text, connectionId);
        return;
      }
      case 'turn/completed':
        this.finishTurn(session, params.turn);
        return;
      case 'serverRequest/resolved':
        session.resolve(JSON.stringify(params.requestId), connectionId);
        return;
      case 'error':
        session.diagnostics.add(`Codex non-terminal error: ${JSON.stringify(params.error)}`);
        return;
      default:
        // 승인·질문 요청을 요청 ID와 턴 ID에 연결해 입력 대기로 전환한다.
        if (message.id === undefined) return;
        const turnId = codexId(params.turnId);
        const isQuestion = message.method === 'item/tool/requestUserInput';
        session.waiting({
          id: JSON.stringify(message.id),
          turnId,
          connectionId,
          title: isQuestion
            ? JSON.stringify(params.questions)
            : String(params.command ?? params.reason ?? 'File change approval'),
        });
    }
  }

  // 명시적 턴 상태를 확인하고 최종 본문·오류 설명을 반영한 뒤 종료한다.
  private finishTurn(session: Session, value: unknown): void {
    const connectionId = this.context.connectionId;
    const turn = codexObject(value);
    const turnId = codexId(turn.id);
    const status = codexStatus(String(turn.status));
    if (!status) {
      if (turn.status !== 'inProgress') throw new Error(`Unknown Codex turn status: ${turn.status}`);
      return;
    }
    if (Array.isArray(turn.items)) {
      for (const item of turn.items) {
        const entry = codexObject(item);
        if (entry.type !== 'agentMessage' || entry.phase === 'commentary' || typeof entry.text !== 'string'
          || (Array.isArray(entry.questions) && entry.questions.length > 0)) continue;
        session.body(turnId, entry.text, connectionId);
      }
    }
    let detail: string | undefined;
    if (turn.error) {
      const error = codexObject(turn.error);
      const code = typeof error.codexErrorInfo === 'string' ? error.codexErrorInfo : JSON.stringify(error.codexErrorInfo);
      const message = typeof error.message === 'string' ? error.message : 'No error message received';
      detail = `${code || 'Codex error'}: ${message}`;
    }
    session.finish(turnId, status, connectionId, detail);
  }

  dispose(): void {
    this.pendingThreadStarts.clear();
    this.excludedThreads.clear();
    this.titles.clear();
    diagnostic: this.threadDiagnostics.clear();
  }
}

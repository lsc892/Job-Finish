// 관찰한 Codex 실시간 이벤트를 해석하고 임시·하위 스레드를 제외해 세션에 반영한다.
import type { AgentEvents, EventContext } from '../agent-provider';
import { sessionTitleText } from '../../core/model';
import type { Session } from '../../core/session';
import { CodexAdapter, codexSessionEvent } from './adapter';
import type { RpcMessage } from '../transport';
import { bound, identifier, record } from '../message';

/** 관찰한 Codex 연결에서 알림 대상 스레드를 선별하고 실시간 이벤트를 세션에 반영한다. */
export class CodexEvents implements AgentEvents {
  // thread/start 요청 ID별 임시 스레드 여부를 응답까지 보관한다.
  private readonly pendingThreadStarts = new Map<string, boolean>();
  private readonly excludedThreads = new Set<string>();
  private readonly titles = new Map<string, { name?: string; preview?: string }>();
  constructor(private readonly context: EventContext) {}

  outgoing(message: Record<string, unknown>): void {
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
    if (thread && identifier(thread.id)) {
      const pendingKey = JSON.stringify(message.id);
      if (thread.ephemeral === true || thread.parentThreadId || record(thread.source)?.subAgent
        || this.pendingThreadStarts.get(pendingKey)) {
        this.excludedThreads.add(thread.id as string);
        bound(this.excludedThreads);
      }
      this.pendingThreadStarts.delete(pendingKey);
    }
    if (thread) this.recordTitle(thread);
    if (Array.isArray(result?.data)) {
      for (const item of result.data) {
        const entry = record(item);
        if (entry && typeof entry.preview === 'string') this.recordTitle(entry);
      }
    }
    if (message.method === 'thread/name/updated' && params) {
      this.recordTitle({ id: params.threadId, name: params.threadName });
      return;
    }

    if (typeof message.method !== 'string' || !params) return;
    const id = identifier(params.threadId);
    if (!id || this.excludedThreads.has(id)) return;
    const event = codexSessionEvent(message as RpcMessage);
    if (!event) return;
    const session = this.context.session(id);
    if (!session) return;
    this.applyTitle(session, id);
    const turn = record(params.turn);
    const turnId = identifier(turn?.id ?? params.turnId);
    // A live completion or input request also identifies a turn already running when observation began.
    // Unlike an RPC history response, this comes directly from this window's active runtime connection.
    if (turnId && message.method !== 'error') session.start(turnId, this.context.connectionId);
    new CodexAdapter(session).apply(event, this.context.connectionId, true);
  }

  private recordTitle(thread: Record<string, unknown>): void {
    const id = identifier(thread.id);
    if (!id || this.excludedThreads.has(id)) return;
    if (thread.ephemeral === true || thread.parentThreadId || record(thread.source)?.subAgent) return;
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

  dispose(): void {
    this.pendingThreadStarts.clear();
    this.excludedThreads.clear();
    this.titles.clear();
  }
}

// 관찰 연결 안에서 턴·입력 요청·질문을 추적하고 중복 알림을 제거한다.
import { randomUUID } from 'node:crypto';
import { boundedText, Diagnostics, InputRequest, LIMITS, SessionBinding, sessionTitleText, Signal, TerminalStatus, TurnState } from './model';

export class Session {
  readonly turns = new Map<string, TurnState>();
  readonly completed = new Map<string, TerminalStatus>();
  readonly requests = new Map<string, { turnId: string }>();
  private readonly seenRequests = new Set<string>();
  private readonly seenQuestions = new Set<string>();
  private title?: string;
  private promptTitle?: string;

  constructor(readonly binding: SessionBinding, private readonly emit: (signal: Signal) => void,
    readonly diagnostics: Diagnostics) {}

  valid(connectionId: string): boolean { return connectionId === this.binding.connectionId; }
  get sessionTitle(): string | undefined { return this.title ?? this.promptTitle; }

  setTitle(value: unknown, connectionId: string, fallback = false): void {
    if (!this.valid(connectionId)) return;
    const title = sessionTitleText(value);
    if (!title) return;
    if (fallback) this.promptTitle ??= title;
    else this.title = title;
  }

  start(id: string, connectionId: string): void {
    if (!id || !this.valid(connectionId) || this.completed.has(id) || this.turns.has(id)) return;
    if (this.turns.size >= LIMITS.turns) throw new Error('Active turn limit exceeded');
    this.turns.set(id, { id, status: 'running', text: '', truncated: false });
  }

  body(id: string, text: string, connectionId: string): void {
    if (!this.valid(connectionId)) return;
    const turn = this.turns.get(id);
    if (turn) Object.assign(turn, boundedText(text));
  }

  finish(id: string, status: TerminalStatus, connectionId: string, detail?: string): void {
    if (!this.valid(connectionId)) return;
    const previous = this.completed.get(id);
    if (previous) {
      if (previous !== status) this.diagnostics.add(`Conflicting terminal state for ${id}: ${previous}/${status}`);
      return;
    }
    const turn = this.turns.get(id);
    if (!turn) return;
    this.completed.set(id, status);
    while (this.completed.size > LIMITS.dedup) this.completed.delete(this.completed.keys().next().value!);
    for (const [requestId, request] of this.requests) {
      if (request.turnId === id) this.requests.delete(requestId);
    }
    this.turns.delete(id);
    this.signal({ ...turn, status }, detail);
  }

  waiting(request: InputRequest): void {
    if (!this.valid(request.connectionId)) return;
    const turn = this.turns.get(request.turnId);
    if (!turn || this.seenRequests.has(request.id)) return;
    if (request.id.length > 1024) throw new Error('Input request identifier exceeds limit');
    if (this.requests.size >= LIMITS.requests) throw new Error('Pending request limit exceeded');
    this.seenRequests.add(request.id);
    while (this.seenRequests.size > LIMITS.dedup) this.seenRequests.delete(this.seenRequests.values().next().value!);
    // 응답은 원래 확장이 처리하므로 본문·명령·승인 payload는 보관하지 않는다.
    this.requests.set(request.id, { turnId: request.turnId });
    turn.status = 'waitingForInput';
    this.signal({ ...turn, ...boundedText(request.title) }, undefined, request.id);
  }

  // 비동기 질문은 실행 상태·최종 본문·입력 대기를 바꾸지 않는다.
  notifyQuestion(turnId: string, itemId: string, text: string, connectionId: string): void {
    if (!this.valid(connectionId)) return;
    const turn = this.turns.get(turnId);
    if (!turn || !itemId || !text.trim()) return;
    const key = JSON.stringify([turnId, itemId]);
    if (this.seenQuestions.has(key)) return;
    this.seenQuestions.add(key);
    while (this.seenQuestions.size > LIMITS.dedup) this.seenQuestions.delete(this.seenQuestions.values().next().value!);
    this.signal({ ...turn, ...boundedText(text), status: 'waitingForInput' }, undefined, undefined, 'asyncQuestion');
  }

  resolve(id: string, connectionId: string): void {
    if (!this.valid(connectionId)) return;
    const request = this.requests.get(id);
    if (!request) return;
    this.requests.delete(id);
    const turn = this.turns.get(request.turnId);
    if (turn && ![...this.requests.values()].some(r => r.turnId === turn.id)) turn.status = 'running';
  }

  private signal(turn: TurnState, detail?: string, requestId?: string, kind?: Signal['kind']): void {
    this.emit({ ...this.binding, sessionTitle: this.sessionTitle, notificationId: randomUUID(), turnId: turn.id, status: turn.status,
      text: turn.text, truncated: turn.truncated, detail: detail && boundedText(detail, 2048).text, requestId,
      ...(kind ? { kind } : {}), at: new Date().toISOString() });
  }
}

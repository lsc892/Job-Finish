import { randomUUID } from 'node:crypto';
import { boundedText, Checkpoint, Diagnostics, InputRequest, isTerminal, LIMITS, SessionBinding, Signal, TerminalStatus, TurnState } from './model';

/** Only explicitly admitted turns can notify. History and evicted replay never admit a turn. */
export class Session {
  readonly turns = new Map<string, TurnState>();
  readonly completed = new Map<string, TerminalStatus>();
  readonly requests = new Map<string, InputRequest>();
  private readonly seenRequests = new Set<string>();
  pendingStart?: string;
  constructor(public binding: SessionBinding, private readonly owns: () => boolean,
    private readonly save: (state: Checkpoint) => void, private readonly emit: (signal: Signal) => void,
    readonly diagnostics: Diagnostics, checkpoint?: Checkpoint, private readonly changed: () => void = () => {}) {
    this.pendingStart = checkpoint?.pendingStart;
    for (const [id, status] of checkpoint?.completed.slice(-LIMITS.dedup) ?? []) this.completed.set(id, status);
    for (const turn of checkpoint?.turns.slice(-LIMITS.turns) ?? []) {
      if (!isTerminal(turn.status)) this.turns.set(turn.id, { ...turn, ...boundedText(turn.text), status: 'unknown' });
    }
  }
  valid(connectionId: string): boolean { return connectionId === this.binding.connectionId && this.owns(); }
  start(id: string, connectionId: string): void {
    if (!id || !this.valid(connectionId) || this.completed.has(id) || this.turns.has(id)) return;
    if (this.turns.size >= LIMITS.turns) throw new Error('Active turn limit exceeded');
    this.turns.set(id, { id, status: 'running', text: '', truncated: false }); this.pendingStart = undefined; this.persist();
  }
  beginStart(requestId: string, connectionId: string): void {
    if (!this.valid(connectionId)) throw new Error('Session ownership or connection lost');
    if (this.pendingStart || this.turns.size) throw new Error('Session has an unresolved execution');
    this.pendingStart = requestId; this.persist();
  }
  body(id: string, text: string, connectionId: string): void {
    if (!this.valid(connectionId)) return;
    const turn = this.turns.get(id);
    if (turn && !isTerminal(turn.status)) Object.assign(turn, boundedText(text));
  }
  running(id: string, connectionId: string): void {
    if (!this.valid(connectionId)) return;
    const turn = this.turns.get(id);
    if (turn && turn.status === 'unknown') { turn.status = 'running'; this.persist(); }
  }
  finish(id: string, status: TerminalStatus, connectionId: string, detail?: string, resultId?: string): void {
    if (!this.valid(connectionId)) return;
    const previous = this.completed.get(id);
    if (previous) {
      if (previous !== status) this.diagnostics.add(`Conflicting terminal state for ${id}: ${previous}/${status}; reconcile required`);
      return;
    }
    const turn = this.turns.get(id);
    if (!turn) return; // Unobserved history, including replay outside the bounded dedup horizon.
    turn.status = status; turn.resultId = resultId;
    this.completed.set(id, status);
    while (this.completed.size > LIMITS.dedup) this.completed.delete(this.completed.keys().next().value!);
    this.clearRequests(id); this.turns.delete(id);
    this.persist(); // Durable before delivery: crash may lose delivery, never promise exactly-once.
    this.signal(turn, detail);
  }
  waiting(request: InputRequest): void {
    if (!this.valid(request.connectionId) || !this.turns.has(request.turnId)) return;
    const key = JSON.stringify([request.connectionId, request.id]);
    if (this.seenRequests.has(key)) return;
    if (this.requests.size >= LIMITS.requests) throw new Error('Pending request limit exceeded');
    const bytes = [...this.requests.values(), request].reduce((n, r) => n + Buffer.byteLength(JSON.stringify(r)), 0);
    if (bytes > LIMITS.queueBytes) throw new Error('Pending request bytes exceed 4 MiB');
    this.seenRequests.add(key);
    while (this.seenRequests.size > LIMITS.dedup) this.seenRequests.delete(this.seenRequests.values().next().value!);
    this.requests.set(request.id, request);
    const turn = this.turns.get(request.turnId)!; turn.status = 'waitingForInput'; this.persist();
    this.signal({ ...turn, ...boundedText(request.title) }, undefined, request.id);
  }
  resolve(id: string, connectionId: string): void {
    if (!this.valid(connectionId)) return;
    const request = this.requests.get(id); if (!request) return;
    this.requests.delete(id);
    const turn = this.turns.get(request.turnId);
    if (turn && ![...this.requests.values()].some(r => r.turnId === turn.id)) turn.status = 'running';
    this.persist();
  }
  disconnected(reason: unknown): void {
    this.diagnostics.add(reason); this.requests.clear(); this.seenRequests.clear();
    for (const turn of this.turns.values()) turn.status = 'unknown';
    if (this.owns()) this.persist(); else this.changed();
  }
  reconnect(connectionId: string): void { this.binding = { ...this.binding, connectionId }; this.requests.clear(); this.seenRequests.clear(); this.changed(); }
  startRejected(requestId: string, message: string, connectionId: string): void {
    if (!this.valid(connectionId)) return;
    if (this.pendingStart === requestId) { this.pendingStart = undefined; this.persist(); }
    this.emit({ ...this.binding, scope: 'startRequest', requestId, notificationId: randomUUID(), turnId: '',
      status: 'error', ...boundedText(message), detail: 'Execution start request rejected', at: new Date().toISOString() });
  }
  baseline(ids: readonly { id: string; status: TerminalStatus }[]): void {
    for (const item of ids) if (!this.turns.has(item.id)) this.completed.set(item.id, item.status);
    while (this.completed.size > LIMITS.dedup) this.completed.delete(this.completed.keys().next().value!);
    this.persist();
  }
  checkpoint(): Checkpoint { return { version: 1, completed: [...this.completed], turns: [...this.turns.values()], ...(this.pendingStart ? { pendingStart: this.pendingStart } : {}) }; }
  private persist(): void { this.save(this.checkpoint()); this.changed(); }
  private clearRequests(turnId: string): void { for (const [id, r] of this.requests) if (r.turnId === turnId) this.requests.delete(id); }
  private signal(turn: TurnState, detail?: string, requestId?: string): void {
    if (!this.owns()) return;
    this.emit({ ...this.binding, notificationId: randomUUID(), turnId: turn.id, status: turn.status,
      text: turn.text, truncated: turn.truncated, detail: detail && boundedText(detail, 2048).text, requestId, at: new Date().toISOString() });
  }
}

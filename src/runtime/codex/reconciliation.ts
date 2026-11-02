// Codex 저장 이력으로 확인된 실행과 시작 요청·충돌 결과를 대조한다.
import type { Thread } from '../../protocol/v2/Thread';
import type { Turn } from '../../protocol/v2/Turn';
import type { Diagnostics, TerminalStatus } from '../../core/model';
import { CodexAdapter, codexId, codexObject, codexStatus } from './adapter';
import { CodexHistory } from './history';
import type { RpcMessage, StdioRpc } from '../transport';

/** 저장 이력을 허용된 실행과 대조해 시작 요청·종료 상태·최종 본문을 복구한다. */
export class CodexReconciliation {
  private reconcilingConflict = false;

  constructor(private readonly adapter: CodexAdapter, private readonly diagnostics: Diagnostics,
    private readonly isCurrent: (rpc: StdioRpc) => boolean) {}

  private get session() { return this.adapter.session; }

  private history(rpc: StdioRpc): CodexHistory {
    return new CodexHistory(rpc, this.session.binding.sessionId, this.assertCurrentConnection.bind(this, rpc));
  }

  private assertCurrentConnection(rpc: StdioRpc): void {
    if (!this.isCurrent(rpc) || !rpc.connected || !this.session.valid(rpc.connectionId)) {
      throw new Error('History lookup connection or ownership changed');
    }
  }

  // 저장 이력의 요청·턴 ID를 대조해 추적하던 실행의 상태와 최종 본문을 복구한다.
  async reconcile(thread: Thread, rpc: StdioRpc): Promise<void> {
    if (codexId(thread?.id) !== this.session.binding.sessionId) throw new Error('Invalid thread recovery response');
    const history = this.history(rpc);
    const { turns, truncated } = await history.turns();
    if (truncated) {
      this.diagnostics.add('History baseline limited to the latest 512 turns; older unobserved turns cannot notify');
    }
    const pendingStart = this.session.pendingStart;
    if (pendingStart) {
      for (const turn of turns) {
        if (!await history.matchesStart(turn.id, pendingStart)) continue;
        history.assertCurrent();
        this.session.start(turn.id, rpc.connectionId);
        break;
      }
    }

    this.prepareStoredTurns(thread, turns, history, rpc);
    for (const turn of turns) {
      if (this.retainUnconfirmedTurn(thread, turn)) continue;
      if (this.session.turns.has(turn.id) && codexStatus(turn.status)) {
        const text = await history.finalText(turn.id);
        history.assertCurrent();
        if (text !== undefined) this.session.body(turn.id, text, rpc.connectionId);
      }
      this.adapter.reconcileTurn(turn, rpc.connectionId);
    }
    history.assertCurrent();
    this.session.baseline([...turns].reverse().flatMap(terminalHistoryEntry));
  }

  private prepareStoredTurns(thread: Thread, turns: Turn[], history: CodexHistory, rpc: StdioRpc): void {
    history.assertCurrent();
    this.session.setTitle(thread.name, rpc.connectionId);
    this.session.setTitle(thread.preview, rpc.connectionId, true);
    this.assertObservedActiveTurns(thread, turns);
  }

  private assertObservedActiveTurns(thread: Thread, turns: Turn[]): void {
    const hasUnobservedActiveTurn = turns.some(turn => turn.status === 'inProgress' && !this.session.turns.has(turn.id));
    if (hasUnobservedActiveTurn) {
      throw new Error('Cannot establish ownership of an unobserved active execution');
    }
    if (thread.status?.type === 'active' && !turns.some(turn => turn.status === 'inProgress')) {
      throw new Error('Cannot establish ownership of an unobserved active execution');
    }
  }

  // 저장된 진행 상태를 현재 런타임이 확인하지 못하면 unknown을 유지한다.
  private retainUnconfirmedTurn(thread: Thread, turn: Turn): boolean {
    if (turn.status !== 'inProgress' || thread.status?.type === 'active') return false;
    this.session.disconnected('Stored turn is incomplete but the resumed runtime does not confirm an active execution');
    return true;
  }

  reconcileConflictingResult(message: RpcMessage, rpc: StdioRpc): void {
    const params = codexObject(message.params);
    const turn = codexObject(params.turn);
    const previous = this.session.completed.get(String(turn.id));
    if (params.threadId !== this.session.binding.sessionId || !previous) return;
    if (codexStatus(String(turn.status)) === previous || this.reconcilingConflict) return;
    this.reconcilingConflict = true;
    const reconciliation = this;
    function reconcileReadThread(result: { thread: Thread }): Promise<void> {
      return reconciliation.reconcile(result.thread, rpc);
    }
    // Read-only reconciliation does not create a turn or redeliver a conflicting result.
    void rpc.request<{ thread: Thread }>('thread/read', { threadId: params.threadId, includeTurns: false })
      .then(reconcileReadThread)
      .catch(this.diagnostics.add.bind(this.diagnostics))
      .finally(this.finishConflictReconciliation.bind(this));
  }

  private finishConflictReconciliation(): void { this.reconcilingConflict = false; }

  async readResult(turnId: string, rpc: StdioRpc): Promise<string | undefined> {
    const history = this.history(rpc);
    const text = await history.finalText(turnId);
    history.assertCurrent();
    return text;
  }
}

function terminalHistoryEntry(turn: Turn): { id: string; status: TerminalStatus }[] {
  const status = codexStatus(turn.status);
  return status ? [{ id: turn.id, status }] : [];
}

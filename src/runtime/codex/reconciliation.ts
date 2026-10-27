import type { Thread } from '../../protocol/v2/Thread';
import type { Turn } from '../../protocol/v2/Turn';
import type { Diagnostics } from '../../core/model';
import { CodexAdapter, codexId, codexObject, codexStatus } from './adapter';
import { CodexHistory } from './history';
import type { RpcMessage, StdioRpc } from '../transport';

/** Reconciles saved history without admitting unobserved turns or delivering conflicting results. */
export class CodexReconciliation {
  private reconcilingConflict = false;

  constructor(private readonly adapter: CodexAdapter, private readonly diagnostics: Diagnostics,
    private readonly isCurrent: (rpc: StdioRpc) => boolean) {}

  private get session() { return this.adapter.session; }

  private history(rpc: StdioRpc): CodexHistory {
    return new CodexHistory(rpc, this.session.binding.sessionId, () => {
      if (!this.isCurrent(rpc) || !rpc.connected || !this.session.valid(rpc.connectionId)) {
        throw new Error('History lookup connection or ownership changed');
      }
    });
  }

  async reconcile(thread: Thread, rpc: StdioRpc): Promise<void> {
    if (codexId(thread?.id) !== this.session.binding.sessionId) throw new Error('Invalid thread recovery response');
    const history = this.history(rpc);
    const { turns, truncated } = await history.turns();
    if (truncated) this.diagnostics.add('History baseline limited to the latest 512 turns; older unobserved turns cannot notify');
    const pending = this.session.pendingStart;
    if (pending) {
      for (const turn of turns) {
        if (!await history.matchesStart(turn.id, pending)) continue;
        history.assertCurrent();
        this.session.start(turn.id, rpc.connectionId);
        break;
      }
    }
    history.assertCurrent();
    this.assertObservedActiveTurns(thread, turns);
    for (const turn of turns) {
      if (turn.status === 'inProgress' && thread.status?.type !== 'active') {
        this.session.disconnected('Stored turn is incomplete but the resumed runtime does not confirm an active execution');
        continue;
      }
      if (this.session.turns.has(turn.id) && codexStatus(turn.status)) {
        const text = await history.finalText(turn.id);
        history.assertCurrent();
        if (text !== undefined) this.session.body(turn.id, text, rpc.connectionId);
      }
      this.adapter.reconcileTurn(turn, rpc.connectionId);
    }
    history.assertCurrent();
    this.session.baseline([...turns].reverse().flatMap(turn => {
      const status = codexStatus(turn.status);
      return status ? [{ id: turn.id, status }] : [];
    }));
  }

  private assertObservedActiveTurns(thread: Thread, turns: Turn[]): void {
    if (turns.some(turn => turn.status === 'inProgress' && !this.session.turns.has(turn.id))) {
      throw new Error('Cannot establish ownership of an unobserved active execution');
    }
    if (thread.status?.type === 'active' && !turns.some(turn => turn.status === 'inProgress')) {
      throw new Error('Cannot establish ownership of an unobserved active execution');
    }
  }

  reconcileConflictingResult(message: RpcMessage, rpc: StdioRpc): void {
    const params = codexObject(message.params);
    const turn = codexObject(params.turn);
    const previous = this.session.completed.get(String(turn.id));
    if (params.threadId !== this.session.binding.sessionId || !previous
      || codexStatus(String(turn.status)) === previous || this.reconcilingConflict) return;
    this.reconcilingConflict = true;
    // Read-only reconciliation does not create a turn or redeliver a conflicting result.
    void rpc.request<{ thread: Thread }>('thread/read', { threadId: params.threadId, includeTurns: false })
      .then(result => this.reconcile(result.thread, rpc))
      .catch(error => this.diagnostics.add(error))
      .finally(() => { this.reconcilingConflict = false; });
  }

  async readResult(turnId: string, rpc: StdioRpc): Promise<string | undefined> {
    const history = this.history(rpc);
    const text = await history.finalText(turnId);
    history.assertCurrent();
    return text;
  }
}

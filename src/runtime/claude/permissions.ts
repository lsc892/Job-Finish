import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk' with { 'resolution-mode': 'import' };
import type { Session } from '../../core/session';
import { LIMITS } from '../../core/model';

export interface ClaudeTurnContext { requestId: string; connectionId: string; acceptingInput: boolean }
type ToolPermissionOptions = Parameters<CanUseTool>[2];

/** Owns pending SDK permissions and abort listeners for the current execution. */
export class ClaudePermissions {
  private readonly pending = new Map<string, { context: ClaudeTurnContext; resolve: (answer: PermissionResult) => void; cleanup: () => void }>();

  constructor(private readonly session: Session, private readonly accepts: (context: ClaudeTurnContext) => boolean) {}

  forTurn(context: ClaudeTurnContext): CanUseTool {
    return async (toolName, input, options) => {
      if (!this.accepts(context) || options.signal.aborted) return { behavior: 'deny', message: 'Execution no longer active' };
      if (this.pending.size >= LIMITS.requests || Buffer.byteLength(JSON.stringify(input)) > LIMITS.textBytes) throw new Error('Claude input request exceeds bounded capacity');
      return this.waitForPermission(context, toolName, input, options);
    };
  }

  private waitForPermission(context: ClaudeTurnContext, toolName: string, input: Parameters<CanUseTool>[1], options: ToolPermissionOptions): Promise<PermissionResult> {
    const id = options.requestId || options.toolUseID;
    // SDK deduplicates in-flight control requests before invoking the callback.
    if (this.pending.has(id)) throw new Error('Duplicate concurrent SDK control callback');
    return new Promise<PermissionResult>(resolve => {
      const abort = () => { this.settle(id, { behavior: 'deny', message: 'Request withdrawn' }); };
      this.pending.set(id, { context, resolve, cleanup: () => options.signal.removeEventListener('abort', abort) });
      options.signal.addEventListener('abort', abort, { once: true });
      try {
        this.session.waiting({ id, turnId: context.requestId, connectionId: context.connectionId,
          kind: toolName === 'AskUserQuestion' ? 'question' : 'approval', title: options.title ?? `${toolName}: ${JSON.stringify(input)}`,
          payload: { toolName, input } });
        if (options.signal.aborted || !this.session.requests.has(id)) abort();
      } catch (error) {
        this.session.diagnostics.add(error);
        this.settle(id, { behavior: 'deny', message: 'Cannot record input request' });
      }
    });
  }

  respond(id: string, result: unknown): void {
    const pending = this.pending.get(id);
    if (!pending || !this.accepts(pending.context) || !this.session.requests.has(id)) {
      this.settle(id, { behavior: 'deny', message: 'Request no longer active or owned' });
      throw new Error('Request no longer pending or owned');
    }
    this.settle(id, result as PermissionResult);
  }

  private settle(id: string, result: PermissionResult): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.cleanup();
    try { this.session.resolve(id, pending.context.connectionId); }
    catch (error) { this.session.diagnostics.add(error); result = { behavior: 'deny', message: 'Cannot record input response' }; }
    finally { pending.resolve(result); }
  }

  clear(): void {
    for (const id of [...this.pending.keys()]) this.settle(id, { behavior: 'deny', message: 'Execution finished or disconnected' });
  }
}

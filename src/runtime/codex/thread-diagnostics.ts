// 스레드 메타데이터 수신 경로와 실제 제외 판정을 기록하며 알림 정책에는 관여하지 않는다.
import { LIMITS } from '../../core/model';
import { bound, identifier, record } from '../message';
import { isExcludedCodexThread } from './thread-metadata';

interface ThreadRequest { method: string; ephemeral: boolean | null }
interface ThreadMetadata {
  metadataRoute: string;
  metadataMethod: string;
  parentThreadId: string | null;
  sourceKind: string | null;
  sourceSubAgent: boolean;
  sourceSubagentLowercase: boolean;
  subAgentParentThreadId: string | null;
  agentPath: string | null;
  threadSource: string | null;
  ephemeral: boolean | null;
  exclusionCandidate: boolean;
}

const label = (value: unknown): string | null => typeof value === 'string' ? value.slice(0, 256) : null;
const flag = (value: unknown): boolean | null => typeof value === 'boolean' ? value : null;
const requestKey = (value: unknown): string | undefined =>
  (identifier(value) || (typeof value === 'number' && Number.isFinite(value))) ? JSON.stringify(value) : undefined;

/** 진단 이력만 제한된 수만큼 보관한다. 제외 등록·세션 생성은 기존 처리에 맡긴다. */
export class CodexThreadDiagnostics {
  private readonly requests = new Map<string, ThreadRequest>();
  private readonly metadata = new Map<string, ThreadMetadata>();
  constructor(private readonly trace: (event: string, fields: Record<string, unknown>) => void,
    private readonly excluded: ReadonlySet<string>) {}

  outgoing(message: Record<string, unknown>): void {
    if (typeof message.method !== 'string' || !message.method.startsWith('thread/')) return;
    const method = message.method.slice(0, 128);
    const params = record(message.params);
    const key = requestKey(message.id);
    if (key) {
      this.requests.set(key, { method, ephemeral: flag(params?.ephemeral) });
      bound(this.requests);
    }
    this.trace('codex.thread.request', { method, requestId: key ?? null,
      sessionId: identifier(params?.threadId) ?? null, ephemeral: flag(params?.ephemeral),
      includeTurns: flag(params?.includeTurns) });
  }

  incoming(message: Record<string, unknown>): void {
    const params = record(message.params), result = record(message.result);
    const response = message.method === undefined && ('result' in message || 'error' in message);
    const key = response ? requestKey(message.id) : undefined;
    const request = key ? this.requests.get(key) : undefined;
    if (key) this.requests.delete(key);
    const method = typeof message.method === 'string' ? message.method.slice(0, 128) : request?.method ?? 'rpc-response';
    if (request) this.trace('codex.thread.response', { method, requestId: key, failed: !!message.error,
      hasThread: !!record(result?.thread), dataCount: Array.isArray(result?.data) ? result.data.length : null });
    const thread = record(params?.thread ?? result?.thread);
    if (thread) this.remember(thread, params?.thread != null ? 'params.thread' : 'result.thread', method, key, request);
    if (Array.isArray(result?.data)) {
      for (const value of result.data) {
        const entry = record(value);
        if (entry && (request?.method === 'thread/list' || typeof entry.preview === 'string')) {
          this.remember(entry, 'result.data', method, key, request);
        }
      }
    }
  }

  private remember(thread: Record<string, unknown>, route: string, method: string, requestId: string | undefined,
    request: ThreadRequest | undefined): void {
    const id = identifier(thread.id);
    if (!id) return;
    const source = record(thread.source);
    const subAgent = record(source?.subAgent ?? source?.subagent);
    const spawn = record(subAgent?.thread_spawn ?? subAgent?.threadSpawn);
    // 실제 제외 등록과 같은 조건으로 기록해 진단과 알림 판정의 차이를 막는다.
    const metadata: ThreadMetadata = {
      metadataRoute: route, metadataMethod: method,
      parentThreadId: identifier(thread.parentThreadId ?? thread.parent_thread_id) ?? null,
      sourceKind: typeof thread.source === 'string' ? label(thread.source)
        : source ? Object.keys(source).slice(0, 8).map(key => key.slice(0, 32)).join(',') : null,
      sourceSubAgent: !!source?.subAgent, sourceSubagentLowercase: !!source?.subagent,
      subAgentParentThreadId: identifier(spawn?.parent_thread_id ?? spawn?.parentThreadId) ?? null,
      agentPath: label(spawn?.agent_path ?? spawn?.agentPath), threadSource: label(thread.threadSource ?? thread.thread_source),
      ephemeral: flag(thread.ephemeral),
      exclusionCandidate: !!(isExcludedCodexThread(thread)
        || (route !== 'result.data' && request?.method === 'thread/start' && request.ephemeral)),
    };
    this.metadata.set(id, metadata);
    if (this.metadata.size > LIMITS.dedup) {
      this.trace('codex.thread.metadata.evicted', { sessionId: this.metadata.keys().next().value, reason: 'capacity' });
      bound(this.metadata);
    }
    this.trace('codex.thread.metadata', { sessionId: id, requestId: requestId ?? null, ...metadata,
      pendingEphemeral: request?.ephemeral ?? null, excluded: this.excluded.has(id) });
  }

  turn(message: Record<string, unknown>, params: Record<string, unknown>): void {
    if (message.method !== 'turn/started' && message.method !== 'turn/completed') return;
    const id = identifier(params.threadId);
    if (!id) return;
    const metadata = this.metadata.get(id);
    const excluded = this.excluded.has(id);
    const turn = record(params.turn);
    this.trace('codex.turn.selection', { sessionId: id, method: message.method,
      turnId: identifier(turn?.id ?? params.turnId) ?? null,
      rootTurnId: identifier(turn?.rootTurnId ?? params.rootTurnId) ?? null,
      parentTurnId: identifier(turn?.parentTurnId ?? params.parentTurnId) ?? null,
      status: label(turn?.status), metadataSeen: !!metadata, ...metadata,
      excluded, decision: excluded ? 'excluded' : 'accepted',
      reason: excluded ? 'excluded-thread' : !metadata ? 'metadata-unseen'
        : metadata.exclusionCandidate ? 'exclusion-not-registered' : 'not-excluded' });
  }

  clear(): void { this.requests.clear(); this.metadata.clear(); }
}

// 같은 Extension Host의 실행 인자와 확장 경로를 대조해 에이전트 프로세스를 찾는다.
import { ChildProcess } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { Diagnostics, LIMITS, Provider, Signal } from '../core/model';
import { ObservedConnection } from './observed-connection';
import type { AgentProviderRegistry } from './agent-provider';
import { agentProviders } from './providers';

export interface AgentRoot { provider: Provider; path: string }
interface Spawnable { spawn: (...args: unknown[]) => unknown }
const canonical = (path: string) => path.replace(/\\/g, '/').toLowerCase();

// Node's spawn method and active-handle discovery are internal compatibility points, not vendor APIs.
/** 현재 Extension Host의 기존·신규 제공자 프로세스를 관찰하고 확인된 실행 신호를 전달한다. */
export class AgentStreamObserver {
  private readonly connections = new Map<ChildProcess, ObservedConnection>();
  private restoreSpawn?: () => void;
  private readonly delivered = new Map<string, string>();
  private enabled = false;
  constructor(private windowInstanceId: string, private roots: () => AgentRoot[], private emit: (signal: Signal) => void,
    private diagnostics: Diagnostics, private isOwned: (provider: Provider, sessionId: string) => boolean = () => false,
    private providers: AgentProviderRegistry = agentProviders) {}

  start(): void {
    if (this.enabled) return;
    this.enabled = true;
    if (!this.observeFutureProcesses()) return;
    this.discoverExistingProcesses();
  }

  // spawn을 감싸 새 자식 프로세스가 생성될 때 관찰 대상을 확인한다.
  private observeFutureProcesses(): boolean {
    const prototype = ChildProcess.prototype as unknown as Spawnable;
    const original = prototype.spawn;
    if (typeof original !== 'function') { this.enabled = false; this.diagnostics.add('Automatic observation unavailable: Node spawn method missing'); return false; }
    const observer = this;
    function spawn(this: ChildProcess, ...args: unknown[]): unknown {
      const result = Reflect.apply(original, this, args);
      try {
        const options = args[0] as { envPairs?: string[] } | undefined;
        if (!options?.envPairs?.includes('JOB_FINISH_OWNED_EXECUTION=1')) observer.consider(this, false, () => new Error().stack ?? '');
      } catch (error) { observer.diagnostics.add(`Automatic observation: ${error}`); }
      return result;
    }
    try { prototype.spawn = spawn; }
    catch (error) { this.enabled = false; this.diagnostics.add(`Automatic observation unavailable: ${error}`); return false; }
    this.restoreSpawn = () => { if (prototype.spawn === spawn) prototype.spawn = original; };
    return true;
  }

  // 현재 Extension Host가 이미 보유한 자식 프로세스 핸들에서 관찰 대상을 찾는다.
  private discoverExistingProcesses(): void {
    const handles = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles;
    if (!handles) this.diagnostics.add('Existing process discovery unavailable in this Node runtime');
    try {
      for (const handle of handles?.call(process) ?? []) if (handle instanceof ChildProcess) this.consider(handle, true);
    } catch (error) { this.diagnostics.add(`Existing process discovery failed: ${error}`); }
  }

  // 제공자 실행 인자와 설치 확장 경로가 확인된 프로세스만 관찰한다.
  private consider(child: ChildProcess, existing: boolean, stack: () => string = () => ''): void {
    if (!this.enabled || this.connections.has(child) || !child.pid || child.exitCode !== null || child.signalCode !== null || !child.stdout || !child.stdin) return;
    const args = child.spawnargs ?? [];
    const implementation = this.providers.match(args);
    if (!implementation) return;
    const provider = implementation.id;
    const roots = this.roots().filter(root => root.provider === provider).map(root => canonical(resolve(root.path)) + '/');
    const pathMatches = args.some(arg => isAbsolute(arg) && roots.some(root => canonical(resolve(arg)).startsWith(root)));
    if (!pathMatches && !roots.some(root => canonical(stack()).includes(root))) return;
    if (this.connections.size >= 16) { this.diagnostics.add('Automatic observation connection limit reached'); return; }
    this.attach(child, provider, existing);
  }

  private attach(child: ChildProcess, provider: Provider, existing: boolean): void {
    const connection = new ObservedConnection(child, {
      provider,
      windowInstanceId: this.windowInstanceId,
      existing,
      diagnostics: this.diagnostics,
      providers: this.providers,
      emit: this.deliverSignal.bind(this),
      isOwned: this.isOwned,
      closed: this.removeConnection.bind(this, child),
    });
    this.connections.set(child, connection);
    connection.start();
  }

  private deliverSignal(signal: Signal): void {
    // CLI 종료 후 토스트 등록이 완료돼도 이 신호의 소유권은 유지한다.
    this.delivered.set(signal.notificationId, signal.connectionId);
    while (this.delivered.size > LIMITS.dedup) this.delivered.delete(this.delivered.keys().next().value!);
    this.emit(signal);
  }

  private removeConnection(child: ChildProcess): void {
    this.connections.delete(child);
  }

  owns(signal: Signal): boolean {
    return this.enabled && signal.windowInstanceId === this.windowInstanceId && signal.source === 'verifiedIntegration'
      && this.delivered.get(signal.notificationId) === signal.connectionId;
  }
  snapshot() { return { enabled: this.enabled, connections: [...this.connections.values()].map(c => ({ ...c.router.snapshot(), bufferBytes: c.bufferBytes })),
    discovery: 'extension-host-stdio', pollingTimers: 0 }; }
  stop(): void {
    this.enabled = false; this.restoreSpawn?.(); this.restoreSpawn = undefined;
    for (const connection of [...this.connections.values()]) connection.dispose();
    this.delivered.clear();
  }
  dispose(): void { this.stop(); }
}

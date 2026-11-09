// 같은 Extension Host의 실행 인자와 확장 경로를 대조해 에이전트 프로세스를 찾는다.
import { ChildProcess } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { Diagnostics, LIMITS, Provider, Signal } from '../core/model';
import { ObservedConnection } from './observed-connection';
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
    private diagnostics: Diagnostics) {}

  start(): void {
    if (this.enabled) return;
    this.enabled = true;
    diagnostic: this.diagnostics.trace('observer.started', { windowInstanceId: this.windowInstanceId, extensionHostPid: process.pid, roots: this.roots() });
    // 신규 spawn을 먼저 관찰한 뒤 기존 핸들을 탐색해 그 사이 생성된 프로세스도 놓치지 않는다.
    const prototype = ChildProcess.prototype as unknown as Spawnable;
    const original = prototype.spawn;
    if (typeof original !== 'function') { this.enabled = false; this.diagnostics.add('Automatic observation unavailable: Node spawn method missing'); return; }
    const observer = this;
    function spawn(this: ChildProcess, ...args: unknown[]): unknown {
      const result = Reflect.apply(original, this, args);
      try {
        observer.consider(this, false, () => new Error().stack ?? '');
      } catch (error) { observer.diagnostics.add(`Automatic observation: ${error}`); }
      return result;
    }
    try { prototype.spawn = spawn; }
    catch (error) { this.enabled = false; this.diagnostics.add(`Automatic observation unavailable: ${error}`); return; }
    this.restoreSpawn = () => { if (prototype.spawn === spawn) prototype.spawn = original; };
    const handles = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles;
    if (!handles) this.diagnostics.add('Existing process discovery unavailable in this Node runtime');
    try {
      for (const handle of handles?.call(process) ?? []) if (handle instanceof ChildProcess) this.consider(handle, true);
    } catch (error) { this.diagnostics.add(`Existing process discovery failed: ${error}`); }
    diagnostic: this.diagnostics.trace('observer.discovery.complete', { windowInstanceId: this.windowInstanceId,
      connections: this.connections.size, existingProcessDiscovery: !!handles });
  }

  // 제공자 실행 인자와 설치 확장 경로가 확인된 프로세스만 관찰한다.
  private consider(child: ChildProcess, existing: boolean, stack: () => string = () => ''): void {
    if (!this.enabled || this.connections.has(child) || !child.pid || child.exitCode !== null || child.signalCode !== null || !child.stdout || !child.stdin) return;
    const args = child.spawnargs ?? [];
    const implementation = Object.values(agentProviders).find(provider => provider.matchesProcess(args));
    if (!implementation) return;
    const provider = implementation.id;
    const roots = this.roots().filter(root => root.provider === provider).map(root => canonical(resolve(root.path)) + '/');
    const pathMatches = args.some(arg => isAbsolute(arg) && roots.some(root => canonical(resolve(arg)).startsWith(root)));
    if (!pathMatches && !roots.some(root => canonical(stack()).includes(root))) {
      diagnostic: this.diagnostics.trace('observer.candidate.rejected', { windowInstanceId: this.windowInstanceId, provider,
        pid: child.pid, existing, reason: 'extension-path-mismatch', roots });
      return;
    }
    if (this.connections.size >= 16) { this.diagnostics.add('Automatic observation connection limit reached'); return; }
    const connection = new ObservedConnection(child, {
      provider,
      windowInstanceId: this.windowInstanceId,
      existing,
      diagnostics: this.diagnostics,
      emit: this.deliverSignal.bind(this),
      closed: () => { this.connections.delete(child); },
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

  owns(signal: Signal): boolean {
    return this.enabled && signal.windowInstanceId === this.windowInstanceId
      && this.delivered.get(signal.notificationId) === signal.connectionId;
  }
  snapshot() { return { enabled: this.enabled, connections: [...this.connections.values()].map(c => ({ ...c.router.snapshot(), bufferBytes: c.bufferBytes })),
    roots: this.roots(), discovery: 'extension-host-stdio', pollingTimers: 0 }; }
  stop(): void {
    diagnostic: if (this.enabled) this.diagnostics.trace('observer.stopped', { windowInstanceId: this.windowInstanceId, connections: this.connections.size });
    this.enabled = false; this.restoreSpawn?.(); this.restoreSpawn = undefined;
    for (const connection of [...this.connections.values()]) connection.dispose();
    this.delivered.clear();
  }
  dispose(): void { this.stop(); }
}

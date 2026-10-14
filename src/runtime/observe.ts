import { ChildProcess } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import type { Writable } from 'node:stream';
import { Diagnostics, LIMITS, Provider, Signal } from '../core/model';
import { AgentEventRouter } from './event-router';

export interface AgentRoot { provider: Provider; path: string }
interface Spawnable { spawn: (...args: unknown[]) => unknown }
const canonical = (path: string) => path.replace(/\\/g, '/').toLowerCase();

/** Independent, bounded decoder: errors stop observation, never the original stream. */
class Frames {
  private buffer = Buffer.alloc(0);
  private length = 0;
  private first = true;
  constructor(private receive: (value: unknown) => void, private allowPartialStart: boolean) {}
  push(chunk: Buffer): void {
    let start = 0;
    for (let at = 0; at < chunk.length; at++) if (chunk[at] === 10) {
      this.append(chunk.subarray(start, at)); start = at + 1;
      if (!this.length) continue;
      let value: unknown;
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(this.buffer.subarray(0, this.length))); }
      catch (error) { if (!this.first || !this.allowPartialStart) throw error; }
      this.first = false; this.length = 0;
      if (value !== undefined) this.receive(value);
    }
    this.append(chunk.subarray(start));
  }
  private append(chunk: Buffer): void {
    const length = this.length + chunk.length;
    if (length > LIMITS.messageBytes) throw new Error('Observed stream frame exceeds 1 MiB');
    if (length > this.buffer.length) {
      const next = Buffer.allocUnsafe(Math.min(LIMITS.messageBytes, Math.max(4096, length, this.buffer.length * 2)));
      this.buffer.copy(next, 0, 0, this.length); this.buffer = next;
    }
    chunk.copy(this.buffer, this.length); this.length = length;
  }
  clear(): void { this.buffer = Buffer.alloc(0); this.length = 0; }
  get capacity(): number { return this.buffer.length; }
}

/** Observes agent children in this window's Extension Host, including children already alive.
 * Node's spawn method and active-handle discovery are internal compatibility points, not vendor APIs.
 * No polling, child creation, stream redirection, hooks, or provider configuration changes.
 */
export class AgentStreamObserver {
  private readonly connections = new Map<ChildProcess, { router: AgentEventRouter; dispose(): void; bytes(): number }>();
  private restoreSpawn?: () => void;
  private readonly delivered = new Map<string, string>();
  private enabled = false;
  constructor(private windowInstanceId: string, private roots: () => AgentRoot[], private emit: (signal: Signal) => void,
    private diagnostics: Diagnostics, private isOwned: (provider: Provider, sessionId: string) => boolean = () => false) {}

  start(): void {
    if (this.enabled) return;
    this.enabled = true;
    const prototype = ChildProcess.prototype as unknown as Spawnable;
    const original = prototype.spawn;
    if (typeof original !== 'function') { this.enabled = false; this.diagnostics.add('Automatic observation unavailable: Node spawn method missing'); return; }
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
    catch (error) { this.enabled = false; this.diagnostics.add(`Automatic observation unavailable: ${error}`); return; }
    this.restoreSpawn = () => { if (prototype.spawn === spawn) prototype.spawn = original; };
    // Existing stdio handles belong to this Extension Host, so they already identify the window.
    const handles = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles;
    if (!handles) this.diagnostics.add('Existing process discovery unavailable in this Node runtime');
    try {
      for (const handle of handles?.call(process) ?? []) if (handle instanceof ChildProcess) this.consider(handle, true);
    } catch (error) { this.diagnostics.add(`Existing process discovery failed: ${error}`); }
  }

  private consider(child: ChildProcess, existing: boolean, stack: () => string = () => ''): void {
    if (!this.enabled || this.connections.has(child) || !child.pid || child.exitCode !== null || child.signalCode !== null || !child.stdout || !child.stdin) return;
    const args = child.spawnargs ?? [];
    const outputJson = args.some((arg, i) => arg === '--output-format=stream-json' || arg === '--output-format' && args[i + 1] === 'stream-json');
    const provider: Provider | undefined = args.includes('app-server') ? 'codex' : outputJson ? 'claude' : undefined;
    if (!provider) return;
    const roots = this.roots().filter(root => root.provider === provider).map(root => canonical(resolve(root.path)) + '/');
    const pathMatches = args.some(arg => isAbsolute(arg) && roots.some(root => canonical(resolve(arg)).startsWith(root)));
    if (!pathMatches && !roots.some(root => canonical(stack()).includes(root))) return;
    if (this.connections.size >= 16) { this.diagnostics.add('Automatic observation connection limit reached'); return; }
    this.attach(child, provider, existing);
  }

  private attach(child: ChildProcess, provider: Provider, existing: boolean): void {
    const input = child.stdin!; const output = child.stdout!;
    const router = new AgentEventRouter(provider, this.windowInstanceId, `${provider}:extension-host:${process.pid}:${child.pid}`,
      signal => {
        // A completed CLI can exit before Windows finishes registering the toast helper.
        this.delivered.set(signal.notificationId, signal.connectionId);
        while (this.delivered.size > LIMITS.dedup) this.delivered.delete(this.delivered.keys().next().value!);
        this.emit(signal);
      }, this.diagnostics, this.isOwned);
    const incoming = new Frames(value => router.incoming(value), existing);
    const outgoing = new Frames(value => router.outgoing(value), existing);
    const originalWrite = input.write;
    let disposed = false;
    const fail = (error: unknown) => { this.diagnostics.add(`Observed ${provider} connection stopped: ${error}`); dispose(); };
    const data = (chunk: Buffer | string) => { try { incoming.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); } catch (error) { fail(error); } };
    const write = function(this: Writable, ...args: unknown[]): boolean {
      // Forward the exact original arguments and return value; the observer cannot block or alter input.
      const result = Reflect.apply(originalWrite, this, args) as boolean;
      if (!disposed) try {
        const chunk = args[0]; const encoding = typeof args[1] === 'string' ? args[1] as BufferEncoding : 'utf8';
        if (typeof chunk === 'string') outgoing.push(Buffer.from(chunk, encoding));
        else if (chunk instanceof Uint8Array) outgoing.push(Buffer.from(chunk));
      } catch (error) { fail(error); }
      return result;
    } as Writable['write'];
    const dispose = () => {
      if (disposed) return; disposed = true;
      output.removeListener('data', data); output.removeListener('end', dispose); child.removeListener('close', dispose);
      if (input.write === write) input.write = originalWrite;
      incoming.clear(); outgoing.clear(); router.dispose(); this.connections.delete(child);
    };
    this.connections.set(child, { router, dispose, bytes: () => incoming.capacity + outgoing.capacity });
    // A child can exit before its final stdout bytes are drained; retain observation until stream closure.
    input.write = write; output.on('data', data); output.once('end', dispose); child.once('close', dispose);
  }

  owns(signal: Signal): boolean {
    return this.enabled && signal.windowInstanceId === this.windowInstanceId && signal.source === 'verifiedIntegration'
      && this.delivered.get(signal.notificationId) === signal.connectionId;
  }
  snapshot() { return { enabled: this.enabled, connections: [...this.connections.values()].map(c => ({ ...c.router.snapshot(), bufferBytes: c.bytes() })),
    discovery: 'extension-host-stdio', pollingTimers: 0 }; }
  stop(): void {
    this.enabled = false; this.restoreSpawn?.(); this.restoreSpawn = undefined;
    for (const connection of [...this.connections.values()]) connection.dispose();
    this.delivered.clear();
  }
  dispose(): void { this.stop(); }
}

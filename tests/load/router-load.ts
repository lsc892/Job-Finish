// 합성 에이전트 스트림의 대량 이벤트로 관찰·라우팅 성능과 보관 상태를 측정한다.
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentStreamObserver } from '../../src/runtime/observe';
import { Diagnostics, LIMITS, Signal } from '../../src/core/model';

const CONNECTIONS = 8;
const WARMUP_TURNS = 5000;
const MEASURED_TURNS = 100000;
type ObserverState = ReturnType<AgentStreamObserver['snapshot']>;
interface MeasurementStart { memory: NodeJS.MemoryUsage; cpu: NodeJS.CpuUsage; time: number }
interface LoadMeasurement { before: NodeJS.MemoryUsage; after: NodeJS.MemoryUsage; elapsedMs: number; cpuMs: number }

// Synthetic agents supply transport data. The router itself creates no child process.
class RouterLoadProbe {
  private readonly results: Signal[] = [];
  private readonly diagnostics = new Diagnostics();
  private readonly observer: AgentStreamObserver;
  private readonly children: ChildProcessWithoutNullStreams[];
  private delivered = 0;

  constructor(private readonly baseline: NodeJS.MemoryUsage) {
    this.observer = new AgentStreamObserver('load', () => [{ provider: 'codex', path: resolve('tests/fixtures') }],
      signal => this.recordSignal(signal), this.diagnostics);
    this.children = this.spawnAgents();
    this.observer.start();
  }

  async run(): Promise<void> {
    try {
      await this.warmUp();
      const start = this.startMeasurement();
      await this.sendTurns(WARMUP_TURNS, WARMUP_TURNS + MEASURED_TURNS);
      await this.waitFor(WARMUP_TURNS + MEASURED_TURNS);
      const measurement = this.finishMeasurement(start);
      const state = this.observer.snapshot();
      this.verifyState(state);
      this.saveReport(this.createReport(measurement, state));
    } finally {
      await this.dispose();
    }
  }

  private spawnAgents(): ChildProcessWithoutNullStreams[] {
    const children = Array.from({ length: CONNECTIONS }, () => spawn(process.execPath,
      [resolve('tests/fixtures/observed-agent.cjs'), 'app-server'], { windowsHide: true, stdio: 'pipe' }));
    for (const child of children) {
      child.stdout.resume();
      child.stdin.on('error', () => {});
    }
    return children;
  }

  private recordSignal(signal: Signal): void {
    this.delivered++;
    this.results.push(signal);
    if (this.results.length > LIMITS.results) this.results.shift();
  }

  private packet(id: number): string {
    return JSON.stringify({ events: [
      { method: 'turn/started', params: { threadId: 'thread', turn: { id: String(id), status: 'inProgress' } } },
      { method: 'turn/completed', params: { threadId: 'thread', turn: { id: String(id), status: 'completed', items: [{ type: 'agentMessage', text: 'result 한국어😀' }] } } },
    ] }) + '\n';
  }

  private async sendTurns(first: number, end: number): Promise<void> {
    for (let id = first; id < end; id++) {
      const child = this.children[id % CONNECTIONS]!;
      if (!child.stdin.write(this.packet(id))) await once(child.stdin, 'drain');
    }
  }

  private async waitFor(count: number): Promise<void> {
    const deadline = Date.now() + 45_000;
    while (this.delivered < count) {
      if (Date.now() > deadline || this.diagnostics.entries.length) {
        throw new Error(`Router load failed: ${this.delivered}/${count}: ${JSON.stringify(this.diagnostics.entries)}`);
      }
      await delay(10);
    }
  }

  private async warmUp(): Promise<void> {
    // Warm up parsing and state allocation before comparing retained memory.
    await this.sendTurns(0, WARMUP_TURNS);
    await this.waitFor(WARMUP_TURNS);
  }

  private startMeasurement(): MeasurementStart {
    global.gc?.();
    return { memory: process.memoryUsage(), cpu: process.cpuUsage(), time: performance.now() };
  }

  private finishMeasurement(start: MeasurementStart): LoadMeasurement {
    const elapsedMs = performance.now() - start.time;
    const cpuUsed = process.cpuUsage(start.cpu);
    global.gc?.();
    const after = process.memoryUsage();
    return { before: start.memory, after, elapsedMs, cpuMs: (cpuUsed.user + cpuUsed.system) / 1000 };
  }

  private verifyState(state: ObserverState): void {
    if (state.connections.length !== CONNECTIONS || state.connections.some(connection => connection.sessions !== 1 || connection.activeTurns)) {
      throw new Error('Router connection/state leak');
    }
  }

  private createReport(measurement: LoadMeasurement, state: ObserverState) {
    const { before, after, elapsedMs, cpuMs } = measurement;
    return { turns: MEASURED_TURNS, connections: CONNECTIONS, elapsedMs, cpuMs,
      retainedHeapOverBaseline: after.heapUsed - this.baseline.heapUsed, retainedHeapGrowth: after.heapUsed - before.heapUsed,
      rssGrowth: after.rss - before.rss, baseline: this.baseline, before, after, state,
      routerSpawnedProcesses: 0, scope: 'synthetic stdio; includes fixture driver overhead, excludes child memory; CPU is the full probe' };
  }

  private saveReport(report: unknown): void {
    mkdirSync('test-artifacts', { recursive: true });
    const text = JSON.stringify(report, null, 2);
    writeFileSync('test-artifacts/router-load.json', text);
    console.log(text);
  }

  private async dispose(): Promise<void> {
    this.observer.dispose();
    await Promise.all(this.children.map(child => this.stopAgent(child)));
  }

  private stopAgent(child: ChildProcessWithoutNullStreams): Promise<void> {
    return new Promise(resolve => {
      child.once('close', () => resolve());
      child.kill();
    });
  }
}

global.gc?.();
const probe = new RouterLoadProbe(process.memoryUsage());
void probe.run().catch(error => { console.error(error); process.exitCode = 1; });

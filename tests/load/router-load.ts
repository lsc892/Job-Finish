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

// Synthetic agents supply transport data. The router itself creates no child process.
class RouterLoadProbe {
  private readonly results: Signal[] = [];
  private readonly diagnostics = new Diagnostics();
  private readonly observer: AgentStreamObserver;
  private readonly children: ChildProcessWithoutNullStreams[];
  private delivered = 0;

  constructor(private readonly baseline: NodeJS.MemoryUsage) {
    this.observer = new AgentStreamObserver('load', () => [{ provider: 'codex', path: resolve('tests/fixtures') }],
      signal => {
        this.delivered++;
        this.results.push(signal);
        if (this.results.length > LIMITS.results) this.results.shift();
      }, this.diagnostics);
    this.children = Array.from({ length: CONNECTIONS }, () => spawn(process.execPath,
      [resolve('tests/fixtures/observed-agent.cjs'), 'app-server'], { windowsHide: true, stdio: 'pipe' }));
    for (const child of this.children) {
      child.stdout.resume();
      child.stdin.on('error', () => {});
    }
    this.observer.start();
  }

  async run(): Promise<void> {
    try {
      // Warm up parsing and state allocation before comparing retained memory.
      await this.sendTurns(0, WARMUP_TURNS);
      await this.waitFor(WARMUP_TURNS);
      global.gc?.();
      const start = { memory: process.memoryUsage(), cpu: process.cpuUsage(), time: performance.now() };
      await this.sendTurns(WARMUP_TURNS, WARMUP_TURNS + MEASURED_TURNS);
      await this.waitFor(WARMUP_TURNS + MEASURED_TURNS);
      const elapsedMs = performance.now() - start.time;
      const cpuUsed = process.cpuUsage(start.cpu);
      global.gc?.();
      const after = process.memoryUsage();
      const state = this.observer.snapshot();
      if (state.connections.length !== CONNECTIONS || state.connections.some(connection => connection.sessions !== 1 || connection.activeTurns)) {
        throw new Error('Router connection/state leak');
      }
      const before = start.memory;
      const cpuMs = (cpuUsed.user + cpuUsed.system) / 1000;
      const report = { turns: MEASURED_TURNS, connections: CONNECTIONS, elapsedMs, cpuMs,
        retainedHeapOverBaseline: after.heapUsed - this.baseline.heapUsed, retainedHeapGrowth: after.heapUsed - before.heapUsed,
        rssGrowth: after.rss - before.rss, baseline: this.baseline, before, after, state,
        routerSpawnedProcesses: 0, scope: 'synthetic stdio; includes fixture driver overhead, excludes child memory; CPU is the full probe' };
      mkdirSync('test-artifacts', { recursive: true });
      const text = JSON.stringify(report, null, 2);
      writeFileSync('test-artifacts/router-load.json', text);
      console.log(text);
    } finally {
      await this.dispose();
    }
  }

  private async sendTurns(first: number, end: number): Promise<void> {
    // 턴을 8개 연결에 순환 배분하고 쓰기 버퍼가 차면 drain까지 기다린다.
    for (let id = first; id < end; id++) {
      const child = this.children[id % CONNECTIONS]!;
      const packet = JSON.stringify({ events: [
        { method: 'turn/started', params: { threadId: 'thread', turn: { id: String(id), status: 'inProgress' } } },
        { method: 'turn/completed', params: { threadId: 'thread', turn: { id: String(id), status: 'completed', items: [{ type: 'agentMessage', text: 'result 한국어😀' }] } } },
      ] }) + '\n';
      if (!child.stdin.write(packet)) await once(child.stdin, 'drain');
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

  private async dispose(): Promise<void> {
    this.observer.dispose();
    await Promise.all(this.children.map(child => new Promise<void>(resolve => {
      child.once('close', () => resolve());
      child.kill();
    })));
  }
}

global.gc?.();
const probe = new RouterLoadProbe(process.memoryUsage());
void probe.run().catch(error => { console.error(error); process.exitCode = 1; });

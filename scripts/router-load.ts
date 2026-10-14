import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { AgentStreamObserver } from '../src/runtime/observe';
import { Diagnostics, LIMITS, Signal } from '../src/core/model';

// Synthetic agents supply transport data. The router itself creates no child process.
global.gc?.(); const baseline = process.memoryUsage();
const results: Signal[] = []; let delivered = 0;
const diagnostics = new Diagnostics();
const observer = new AgentStreamObserver('load', () => [{ provider: 'codex', path: resolve('tests/fixtures') }], signal => {
  delivered++; results.push(signal); if (results.length > LIMITS.results) results.shift();
}, diagnostics);
const children = Array.from({ length: 8 }, () => spawn(process.execPath, [resolve('tests/fixtures/observed-agent.cjs'), 'app-server'], { windowsHide: true, stdio: 'pipe' }));
children.forEach(child => { child.stdout.resume(); child.stdin.on('error', () => {}); });
observer.start();
const packet = (id: number) => JSON.stringify({ events: [
  { method: 'turn/started', params: { threadId: 'thread', turn: { id: String(id), status: 'inProgress' } } },
  { method: 'turn/completed', params: { threadId: 'thread', turn: { id: String(id), status: 'completed', items: [{ type: 'agentMessage', text: 'result 한국어😀' }] } } },
] }) + '\n';
async function waitFor(count: number) {
  const deadline = Date.now() + 45_000;
  while (delivered < count) {
    if (Date.now() > deadline || diagnostics.entries.length) throw new Error(`Router load failed: ${delivered}/${count}: ${JSON.stringify(diagnostics.entries)}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function run(): Promise<void> {
  try {
  // Warm up parsing and state allocation before comparing retained memory.
  for (let i = 0; i < 5000; i++) if (!children[i % 8]!.stdin.write(packet(i))) await once(children[i % 8]!.stdin, 'drain');
  await waitFor(5000); global.gc?.(); const before = process.memoryUsage(); const cpu = process.cpuUsage(); const time = performance.now();
  for (let i = 5000; i < 105000; i++) if (!children[i % 8]!.stdin.write(packet(i))) await once(children[i % 8]!.stdin, 'drain');
  await waitFor(105000); const elapsedMs = performance.now() - time; const cpuUsed = process.cpuUsage(cpu); global.gc?.(); const after = process.memoryUsage();
  const state = observer.snapshot();
  if (state.connections.length !== 8 || state.connections.some(c => c.sessions !== 1 || c.activeTurns)) throw new Error('Router connection/state leak');
  const report = { turns: 100000, connections: 8, elapsedMs, cpuMs: (cpuUsed.user + cpuUsed.system) / 1000,
    retainedHeapOverBaseline: after.heapUsed - baseline.heapUsed, retainedHeapGrowth: after.heapUsed - before.heapUsed,
    rssGrowth: after.rss - before.rss, baseline, before, after, state,
    routerSpawnedProcesses: 0, scope: 'synthetic stdio; includes fixture driver overhead, excludes child memory; CPU is the full probe' };
  mkdirSync('test-artifacts', { recursive: true }); writeFileSync('test-artifacts/router-load.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  } finally {
    observer.dispose();
    await Promise.all(children.map(child => new Promise<void>(resolve => { child.once('close', () => resolve()); child.kill(); })));
  }
}
void run().catch(error => { console.error(error); process.exitCode = 1; });

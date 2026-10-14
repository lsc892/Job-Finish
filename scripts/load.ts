import { Session } from '../src/core/session';
import { Diagnostics, LIMITS } from '../src/core/model';
import { JsonLines } from '../src/runtime/transport';
const diagnostics = new Diagnostics();
const sessions = Array.from({ length: 8 }, (_, i) => new Session({ provider: 'codex', runtimeId: 'load', connectionId: 'c', sessionId: `${i}`, windowInstanceId: 'w', source: 'ownedExecution' }, () => true, () => {}, () => {}, diagnostics));
global.gc?.(); const before = process.memoryUsage();
for (let i = 0; i < 100_000; i++) {
  const session = sessions[i % sessions.length]!; const id = `${i}`;
  session.start(id, 'c'); session.body(id, 'result'.repeat(3000), 'c'); session.finish(id, 'completed', 'c'); diagnostics.add('diagnostic');
  const decoder = new JsonLines(() => {}); decoder.push(Buffer.from('{"id":1,"result":true}\n')); decoder.clear();
}
global.gc?.(); const after = process.memoryUsage();
if (sessions.some(s => s.completed.size > LIMITS.dedup || s.turns.size || s.requests.size)) throw new Error('Unbounded retained state');
if (after.heapUsed - before.heapUsed > 32 * 1024 * 1024) throw new Error('Unexpected retained heap growth over 32 MiB');
console.log(JSON.stringify({ events: 100000, sessions: sessions.length, before, after, heapGrowth: after.heapUsed - before.heapUsed, runtimeChildProcesses: 0, diagnostics: diagnostics.entries.length }, null, 2));

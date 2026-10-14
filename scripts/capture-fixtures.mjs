// Copy only event payloads from the marker-only live probes; never persist stderr/config/auth.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
const reports = readdirSync('test-artifacts').filter(f => /^live.*\.json$/.test(f)).flatMap(f => JSON.parse(readFileSync(`test-artifacts/${f}`, 'utf8')).report);
for (const [name, provider, status] of [['codex-success', 'codex', 'completed'], ['codex-api-error', 'codex', 'error'], ['claude-auth-error', 'claude', 'error'], ['claude-success', 'claude', 'completed']]) {
  const report = reports.find(r => r.provider === provider && r.signals?.some(s => s.status === status));
  if (!report) throw new Error(`No captured fixture: ${name}`);
  const signal = report.signals.find(s => s.status === status);
  const relevant = report.events.filter(event => provider === 'claude' ? event.type === 'result' :
    ['turn/started', 'turn/completed'].includes(event.method) || (event.method === 'item/completed' && event.params.item.type === 'agentMessage'));
  let data = JSON.stringify({ source: 'actual-runtime', capturedDateKst: '2026-10-05', provider, expectedStatus: status, sessionId: signal.sessionId, turnId: signal.turnId, events: relevant }, null, 2);
  data = data.replaceAll(signal.sessionId, 'captured-session').replaceAll(signal.turnId, 'captured-turn');
  writeFileSync(`tests/fixtures/${name}.json`, data + '\n');
}
// Keep only the actual result contract; account telemetry and stderr are excluded.
const inputFiles = readdirSync('test-artifacts').filter(f => /^claude-input-\d+\.json$/.test(f)).sort();
const input = JSON.parse(readFileSync(`test-artifacts/${inputFiles.at(-1)}`, 'utf8'));
const limited = input.reports.find(r => r.scenario === 'turn-limit' && r.passed);
const event = limited.events.find(e => e.type === 'result');
const result = Object.fromEntries(['type', 'subtype', 'is_error', 'session_id', 'uuid', 'user_message_uuid', 'errors'].filter(key => key in event).map(key => [key, event[key]]));
let data = JSON.stringify({ source: 'actual-runtime', capturedDateKst: '2026-10-05', provider: 'claude', expectedStatus: 'error',
  sessionId: event.session_id, turnId: limited.signals.at(-1).turnId, events: [result] }, null, 2);
data = data.replaceAll(event.session_id, 'captured-session').replaceAll(limited.signals.at(-1).turnId, 'captured-turn');
writeFileSync('tests/fixtures/claude-turn-limit.json', data + '\n');
const inputs = input.reports.filter(r => r.passed).map(r => ({ scenario: r.scenario, requests: r.requests,
  observedStatuses: r.signals.map(s => s.status), terminalSubtype: r.events.find(e => e.type === 'result')?.subtype }));
writeFileSync('tests/fixtures/claude-input-contracts.json', JSON.stringify({ source: 'actual-runtime', sdkVersion: '0.3.289', capturedDateKst: '2026-10-05',
  note: 'Control callback payloads captured by the product adapter; temporary paths redacted. Cancellation uses a real interrupt acknowledgment, not an invented result event.', scenarios: inputs }, null, 2).replaceAll(JSON.stringify(input.tempWorkspace).slice(1, -1), 'CAPTURED_TEMP') + '\n');

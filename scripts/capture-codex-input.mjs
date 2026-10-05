// Preserve only actual probe events used by the adapter. No config, stderr or reasoning items.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
const records = readdirSync('test-artifacts').filter(f => /^codex-input-\d+\.json$/.test(f)).flatMap(f => {
  const report = JSON.parse(readFileSync(`test-artifacts/${f}`, 'utf8'));
  return report.reports.map(r => ({ ...r, root: report.tempWorkspace }));
});
for (const scenario of ['question', 'approval', 'permissions', 'cancel', 'usage-limit']) {
  const source = records.find(r => scenario === 'usage-limit'
    ? r.events.some(e => e.method === 'turn/completed' && e.params.turn.error?.codexErrorInfo === 'usageLimitExceeded')
    : r.scenario === scenario && r.passed);
  if (!source) throw new Error(`Missing actual ${scenario} probe`);
  const terminal = source.signals.at(-1);
  const events = source.events.filter(e => ['turn/started', 'turn/completed', 'serverRequest/resolved', 'item/tool/requestUserInput', 'item/commandExecution/requestApproval', 'item/permissions/requestApproval'].includes(e.method) ||
    e.method === 'item/completed' && e.params.item.type === 'agentMessage').map(e => {
      if (e.params?.turn) return { ...e, params: { ...e.params, turn: { ...e.params.turn, items: e.params.turn.items.filter(item => item.type === 'agentMessage') } } };
      return e;
    });
  let data = JSON.stringify({ source: 'actual-runtime', cliVersion: '0.160.0', capturedDateKst: '2026-10-05', provider: 'codex', scenario,
    sessionId: terminal.sessionId, turnId: terminal.turnId, expectedStatus: terminal.status, expectedStatuses: source.signals.map(s => s.status), events }, null, 2);
  data = data.replaceAll(terminal.sessionId, 'captured-session').replaceAll(terminal.turnId, 'captured-turn')
    .replaceAll(JSON.stringify(source.root).slice(1, -1), 'CAPTURED_TEMP');
  writeFileSync(`tests/fixtures/codex-${scenario}.json`, data + '\n');
}

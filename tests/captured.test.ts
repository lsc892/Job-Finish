// 실제 기록의 종료·입력 요청 이벤트를 제품의 자동 관찰 경로로 검증한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AgentEventRouter } from '../src/runtime/event-router';
import { Diagnostics, Signal } from '../src/core/model';

for (const name of ['codex-success', 'codex-api-error', 'claude-auth-error', 'claude-success', 'claude-turn-limit',
  'codex-question', 'codex-approval', 'codex-permissions', 'codex-cancel', 'codex-usage-limit']) {
  test(`Captured actual runtime: ${name}`, () => {
    const captured = JSON.parse(readFileSync(`tests/fixtures/${name}.json`, 'utf8'));
    const signals: Signal[] = [];
    const router = new AgentEventRouter(captured.provider, 'window', 'runtime', signal => signals.push(signal), new Diagnostics());
    for (const event of captured.events) router.incoming(event);
    assert.equal(signals.at(-1)!.status, captured.expectedStatus);
    assert.deepEqual(signals.map(signal => signal.status), captured.expectedStatuses ?? [captured.expectedStatus]);
    assert.equal(router.snapshot().activeTurns, 0);
    if (name === 'codex-usage-limit') assert.match(signals.at(-1)!.detail!, /^usageLimitExceeded:/);
    const count = signals.length;
    for (const event of captured.events) router.incoming(event);
    assert.equal(signals.length, count, 'replayed events do not notify again');
    router.dispose();
  });
}

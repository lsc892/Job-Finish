import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CodexAdapter } from '../src/runtime/codex';
import { acceptClaudeResult } from '../src/runtime/claude';
import { fixture } from './helpers';
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk' with { 'resolution-mode': 'import' };
import type { RpcMessage } from '../src/runtime/transport';
for (const name of ['codex-success', 'codex-api-error', 'claude-auth-error', 'claude-success', 'claude-turn-limit']) test(`Captured actual runtime: ${name}`, () => {
  const captured = JSON.parse(readFileSync(`tests/fixtures/${name}.json`, 'utf8'));
  const f = fixture({ provider: captured.provider, sessionId: captured.sessionId });
  if (captured.provider === 'codex') {
    const adapter = new CodexAdapter(f.session);
    for (const event of captured.events as RpcMessage[]) adapter.handle(event, 'connection-1', true);
  } else {
    f.session.start(captured.turnId, 'connection-1');
    for (const event of captured.events as SDKResultMessage[]) acceptClaudeResult(f.session, captured.turnId, event, 'connection-1');
  }
  assert.equal(f.signals.length, 1); assert.equal(f.signals[0]!.status, captured.expectedStatus);
});

for (const scenario of ['question', 'approval', 'permissions', 'cancel', 'usage-limit']) test(`Captured actual Codex ${scenario} lifecycle`, () => {
  const captured = JSON.parse(readFileSync(`tests/fixtures/codex-${scenario}.json`, 'utf8'));
  const f = fixture({ sessionId: captured.sessionId }); const adapter = new CodexAdapter(f.session);
  for (const message of captured.events as RpcMessage[]) adapter.handle(message, 'connection-1', true);
  assert.deepEqual(f.signals.map(s => s.status), captured.expectedStatuses);
  assert.equal(f.signals.at(-1)!.status, captured.expectedStatus); assert.equal(f.session.requests.size, 0);
  if (scenario === 'usage-limit') assert.match(f.signals.at(-1)!.detail!, /^usageLimitExceeded:/);
  for (const message of captured.events as RpcMessage[]) adapter.handle(message, 'connection-1', false);
  assert.deepEqual(f.signals.map(s => s.status), captured.expectedStatuses, 'Replayed history cannot notify again');
});

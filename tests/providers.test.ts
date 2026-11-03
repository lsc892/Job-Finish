import test from 'node:test';
import assert from 'node:assert/strict';
import { agentProviders } from '../src/runtime/providers';

test('Only the supported Codex and Claude stream arguments identify agent processes', () => {
  assert.equal(agentProviders.codex.matchesProcess(['codex.exe', 'app-server']), true);
  assert.equal(agentProviders.codex.matchesProcess(['codex.exe', 'exec']), false);
  assert.equal(agentProviders.claude.matchesProcess(['claude.exe', '--output-format', 'stream-json']), true);
  assert.equal(agentProviders.claude.matchesProcess(['claude.exe', '--output-format=stream-json']), true);
  assert.equal(agentProviders.claude.matchesProcess(['claude.exe', '--output-format', 'json']), false);
  assert.equal(agentProviders.claude.matchesProcess(['claude.exe', '--output-format']), false);
});

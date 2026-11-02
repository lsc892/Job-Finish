// 창·연결·런타임별 독점 소유권과 소유자 복구·Windows 파일 잠금을 검증한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ownership } from '../src/core/ownership';
import { sessionKey } from '../src/core/model';
import { binding } from './helpers';
import { withWindowsFileGate } from '../src/windows/gate';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, openSync, closeSync } from 'node:fs';

test('Exclusive owner across windows, connection generations and alternate runtimes', t => {
  const root = mkdtempSync(join(tmpdir(), 'job-finish-owner-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const owner = new Ownership(root); const lease = owner.claim(binding());
  assert.throws(() => owner.claim(binding({ windowInstanceId: 'B', connectionId: 'new' })), /owned/);
  assert.throws(() => owner.claim(binding({ runtimeId: 'other-runtime' })), /owned/);
  assert.equal(lease.valid(), true);
  lease.save({ version: 1, completed: [['turn', 'completed']], turns: [] }); lease.release();
  const next = owner.claim(binding({ windowInstanceId: 'B' })); assert.deepEqual(next.load()?.completed, [['turn', 'completed']]); next.release();
});

test('A failed second ownership lock rolls back only the newly claimed lock', t => {
  const root = mkdtempSync(join(tmpdir(), 'job-finish-owner-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const owner = new Ownership(root);
  const original = owner.claim(binding());
  const directory = join(root, 'owners');
  const filesBefore = readdirSync(directory).sort();
  const recordsBefore = filesBefore.map(file => readFileSync(join(directory, file), 'utf8'));

  assert.throws(() => owner.claim(binding({ runtimeId: 'other-runtime' })), /owned/);
  assert.deepEqual(readdirSync(directory).sort(), filesBefore);
  assert.deepEqual(filesBefore.map(file => readFileSync(join(directory, file), 'utf8')), recordsBefore);
  assert.equal(original.valid(), true);

  original.release();
  const replacement = owner.claim(binding({ runtimeId: 'other-runtime' }));
  assert.equal(replacement.valid(), true);
  replacement.release();
  assert.deepEqual(readdirSync(directory), []);
});

test('Portable ownership gates distinguish acquisition failures and clean up after action failures', t => {
  const root = mkdtempSync(join(tmpdir(), 'job-finish-owner-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'linux' });
  try {
    const owner = new Ownership(root);
    const lease = owner.claim(binding());
    const directory = join(root, 'owners');
    const lockFile = readdirSync(directory).find(file => {
      const record = JSON.parse(readFileSync(join(directory, file), 'utf8'));
      return record.key === sessionKey(binding());
    });
    assert.ok(lockFile);
    const lock = join(directory, lockFile);
    const gate = lock + '.gate';
    writeFileSync(gate, 'held by another operation');

    assert.throws(() => lease.release(), /Ownership operation busy or interrupted/);
    assert.equal(readFileSync(gate, 'utf8'), 'held by another operation');
    assert.equal(lease.valid(), true);
    unlinkSync(gate);
    lease.release();
    assert.deepEqual(readdirSync(directory), []);

    const previous = owner.claim(binding());
    const lockFiles = readdirSync(directory);
    for (const file of lockFiles) writeFileSync(join(directory, file), '{broken');
    assert.throws(() => owner.claim(binding()), /unverifiable/);
    assert.deepEqual(readdirSync(directory).sort(), lockFiles.sort());
    assert.equal(previous.valid(), false);
  } finally {
    Object.defineProperty(process, 'platform', originalPlatform);
  }
});

test('Opaque session ID case is preserved; release never deletes a different token', t => {
  const root = mkdtempSync(join(tmpdir(), 'job-finish-owner-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const owner = new Ownership(root); const a = owner.claim(binding({ sessionId: 'AbC' })); const b = owner.claim(binding({ sessionId: 'abc' }));
  const path = readdirSync(join(root, 'owners')).filter(f => f.endsWith('.lock')).map(f => join(root, 'owners', f)).find(p => JSON.parse(readFileSync(p, 'utf8')).key.includes('AbC'))!;
  const record = JSON.parse(readFileSync(path, 'utf8')); writeFileSync(path, JSON.stringify({ ...record, token: 'replacement' }));
  assert.equal(a.valid(), false); a.release(); assert.equal(JSON.parse(readFileSync(path, 'utf8')).token, 'replacement'); b.release();
});
test('Dead PID ownership can be reclaimed while malformed ownership fails closed', t => {
  const root = mkdtempSync(join(tmpdir(), 'job-finish-owner-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const owner = new Ownership(root); owner.claim(binding());
  for (const file of readdirSync(join(root, 'owners')).filter(f => f.endsWith('.lock'))) {
    const path = join(root, 'owners', file); const record = JSON.parse(readFileSync(path, 'utf8')); writeFileSync(path, JSON.stringify({ ...record, pid: 2147483647 }));
  }
  const recovered = owner.claim(binding({ windowInstanceId: 'B' })); assert.equal(recovered.valid(), true); recovered.release();
  owner.claim(binding());
  const path = join(root, 'owners', readdirSync(join(root, 'owners')).find(f => f.endsWith('.lock'))!);
  writeFileSync(path, '{broken'); assert.throws(() => owner.claim(binding()), /unverifiable/);
});

test('Windows gate excludes live handles and recovers automatically after forced process exit', { skip: process.platform !== 'win32', timeout: 10_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'job-finish-gate-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'owner.gate');
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/hold-gate.ts', path], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill()); const exit = once(child, 'exit');
  const [ready] = await once(child.stdout, 'data'); assert.match(String(ready), /GATE_HELD/);
  assert.throws(() => withWindowsFileGate(path, () => {}), /busy/);
  child.kill(); await exit;
  withWindowsFileGate(path, () => assert.ok(existsSync(path))); assert.equal(existsSync(path), false);
  const legacy = openSync(path, 'wx');
  try { assert.throws(() => withWindowsFileGate(path, () => {}), /busy/); } finally { closeSync(legacy); }
  // A closed legacy gate can be reclaimed, without age heuristics or deleting a live handle.
  withWindowsFileGate(path, () => {}); assert.equal(existsSync(path), false);
});

test('Windows gate releases its handle after an action throws and preserves the original error', { skip: process.platform !== 'win32' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'job-finish-gate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'owner.gate');
  const cause = new Error('controlled ownership action failure');
  assert.throws(() => withWindowsFileGate(path, () => { throw cause; }), error => error === cause);
  assert.equal(existsSync(path), false);
  assert.equal(withWindowsFileGate(path, () => 'released'), 'released');
  assert.equal(existsSync(path), false);
});

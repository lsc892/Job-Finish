// 설정·PATH 탐색 순서와 셸 없는 Codex 실행 명령 변환을 검증한다.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { codexCommand } from '../src/runtime/codex/executable';

const npmScript = 'node_modules/@openai/codex/bin/codex.js';

function files(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'job-finish-codex-command-'));
  const originalPath = process.env.PATH;
  t.after(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    path: (...parts: string[]) => join(directory, ...parts),
    create(...parts: string[]): string {
      const path = join(directory, ...parts);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, 'fixture');
      return path;
    },
  };
}

test('A configured Codex path overrides PATH and never falls back when missing', t => {
  const fixture = files(t);
  fixture.create('on-path', 'codex.exe');
  process.env.PATH = fixture.path('on-path');
  const configured = fixture.create('configured', 'codex-native.exe');

  assert.deepEqual(codexCommand(configured), { executable: configured, args: ['app-server'] });
  assert.throws(() => codexCommand(fixture.path('missing')), {
    message: 'Codex executable not found. Configure jobFinish.codexExecutable.',
  });
});

test('Codex searches each PATH directory before moving to the next directory', t => {
  const fixture = files(t);
  const first = fixture.create('first', 'codex');
  fixture.create('second', 'codex.exe');
  process.env.PATH = [fixture.path('first'), fixture.path('second')].join(delimiter);

  assert.deepEqual(codexCommand(), { executable: first, args: ['app-server'] });
});

test('Within one PATH directory Codex prefers native, then npm JavaScript, then bare command', t => {
  const fixture = files(t);
  const bare = fixture.create('bin', 'codex');
  process.env.PATH = fixture.path('bin');
  assert.deepEqual(codexCommand(), { executable: bare, args: ['app-server'] });

  const script = fixture.create('bin', npmScript);
  assert.deepEqual(codexCommand(), { executable: process.execPath, args: [script, 'app-server'] });

  const native = fixture.create('bin', 'codex.exe');
  assert.deepEqual(codexCommand(), { executable: native, args: ['app-server'] });
});

test('Codex JavaScript extensions launch through Node regardless of suffix case', t => {
  const fixture = files(t);
  for (const suffix of ['js', 'cjs', 'mjs', 'JS', 'CJS', 'MJS']) {
    const script = fixture.create(`codex.${suffix}`);
    assert.deepEqual(codexCommand(script), { executable: process.execPath, args: [script, 'app-server'] });
  }
});

test('Codex shell shims require their sibling npm script and are never passed to a shell', t => {
  const fixture = files(t);
  for (const [index, suffix] of ['cmd', 'ps1', 'CMD', 'PS1'].entries()) {
    const shim = fixture.create(String(index), `codex.${suffix}`);
    assert.throws(() => codexCommand(shim), {
      message: 'Use a native Codex executable or npm bin/codex.js, not a shell script',
    });

    const script = fixture.create(String(index), npmScript);
    assert.deepEqual(codexCommand(shim), { executable: process.execPath, args: [script, 'app-server'] });
  }
});

test('Codex reports a missing executable after all PATH candidates are exhausted', t => {
  const fixture = files(t);
  process.env.PATH = [fixture.path('empty-first'), fixture.path('empty-second')].join(delimiter);
  assert.throws(() => codexCommand(), {
    message: 'Codex executable not found. Configure jobFinish.codexExecutable.',
  });
});

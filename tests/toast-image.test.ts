// 기본·사용자 지정 이미지, 이미지 끄기와 잘못된 경로의 대체 동작을 검증한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { toastImagePath } from '../src/windows/toast-image';

test('Toast images support the bundled default, custom workspace files, disabling, and invalid-path fallback', t => {
  const extension = resolve('.');
  const defaultPath = join(extension, 'resources', 'icon', 'toast-default.png');
  const png = readFileSync(defaultPath);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(png.length < 200 * 1024);
  assert.equal(toastImagePath(extension, true), defaultPath);
  const workspace = mkdtempSync(join(tmpdir(), 'job-finish-toast-image-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const custom = join(workspace, '강아지 사진.png'); writeFileSync(custom, png);
  assert.equal(toastImagePath(extension, true, custom), custom);
  assert.equal(toastImagePath(extension, true, '강아지 사진.png', workspace), custom);
  let diagnostic = '';
  assert.equal(toastImagePath(extension, false, 'missing.png', workspace, message => { diagnostic = message; }), undefined);
  assert.equal(diagnostic, '');
  mkdirSync(join(workspace, 'directory.png'));
  for (const value of ['missing.png', 'directory.png', 'https://example.com/image.png', 'wrong.txt']) {
    assert.equal(toastImagePath(extension, true, value, workspace, message => { diagnostic = message; }), defaultPath);
    assert.ok(diagnostic.includes('using default image'));
  }
  assert.equal(toastImagePath(extension, true, '강아지 사진.png'), defaultPath);
});

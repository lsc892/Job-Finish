import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { toastMessage, toastTitle } from '../src/core/toast-content';
import { Notifications } from '../src/core/notifications';
import { Signal } from '../src/core/model';
import { toastImagePath } from '../src/windows/toast-image';
import { binding } from './helpers';

test('Toast headers show conversation titles with readable fallbacks instead of status or IDs', () => {
  assert.equal(toastTitle({ title: '  **확장 알림 수정**\n', provider: 'codex' }, 'workspace'), '확장 알림 수정');
  assert.equal(toastTitle({ title: '  ', provider: 'claude' }, '프로젝트 이름'), '프로젝트 이름');
  assert.equal(toastTitle({ provider: 'claude' }), 'Claude 작업');
  assert.equal(Array.from(toastTitle({ title: '😀'.repeat(150), provider: 'codex' })).length, 100);
});

test('Input waiting headers preserve the task title while distinguishing questions and approvals', () => {
  assert.equal(toastTitle({ title: '**확장 알림 수정**', provider: 'codex', status: 'waitingForInput', inputKind: 'question' }),
    'Answer needed · 확장 알림 수정');
  assert.equal(toastTitle({ provider: 'claude', status: 'waitingForInput', inputKind: 'approval' }, '프로젝트 이름'),
    'Approval needed · 프로젝트 이름');
  assert.equal(toastTitle({ title: '확장 알림 수정', provider: 'codex', status: 'completed' }), '확장 알림 수정');
  const longTitle = toastTitle({ title: '😀'.repeat(150), provider: 'codex', status: 'waitingForInput', inputKind: 'question' });
  assert.equal(Array.from(longTitle).length, 100);
  assert.ok(longTitle.startsWith('Answer needed · ') && longTitle.endsWith('…') && !longTitle.includes('�'));
});

test('Notification previews fill available body space while preserving the original AI result', async () => {
  const text = '# 완료\n\n목적별로 `커밋` 두 개를 만들었습니다.\n\n- **abc123** — [Fix](https://example.com)\n\n```text\n테스트 통과\n```';
  const signal: Signal = { ...binding(), title: '커밋 정리', notificationId: 'n', turnId: 't', status: 'completed', text, truncated: false, at: '' };
  let shown = '';
  const notifications = new Notifications({ focused: () => false, owns: () => true,
    stopFlash: () => {}, flash: () => {}, activate: () => {}, toast: async (_signal, message) => { shown = message; } });
  await notifications.deliver(signal);
  assert.equal(shown, '완료 목적별로 커밋 두 개를 만들었습니다. abc123 — Fix 테스트 통과');
  assert.equal(notifications.results[0]!.text, text);
  assert.equal(toastMessage({ text: '\n\u0000 ', detail: '**권한 승인이 필요합니다.**', status: 'waitingForInput' }), '권한 승인이 필요합니다.');
  assert.equal(toastMessage({ text: '', status: 'completed' }), '작업이 완료되었습니다.');
  const longPreview = toastMessage({ text: '😀'.repeat(400), status: 'completed' });
  assert.equal(Array.from(longPreview).length, 360);
  assert.ok(longPreview.endsWith('…') && !longPreview.includes('�'));
});

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

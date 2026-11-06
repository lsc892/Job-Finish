// 설치된 JobFinish.VSCode 등록으로 실제 토스트의 UTF-8 본문·아이콘·줄 수를 확인한다.
// 한글 소스를 PowerShell 파이프로 넘기지 않고 tsx로 이 UTF-8 파일을 직접 실행한다.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Diagnostics, toastText } from '../../src/core/model';
import { ToastProcessRunner } from '../../src/windows/toast/process';

const appId = 'JobFinish.VSCode';
// 반환 XML은 base64로 전송해 PowerShell 콘솔 코드 페이지에 의존하지 않는다.
function history(tag: string, group: string, remove = false): string {
  const command = `[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime] > $null;
    $history = [Windows.UI.Notifications.ToastNotificationManager]::History;
    ${remove ? `$history.Remove('${tag}','${group}','${appId}')` : `
    foreach ($item in $history.GetHistory('${appId}')) {
      if ($item.Tag -eq '${tag}' -and $item.Group -eq '${group}') {
        [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($item.Content.GetXml()))
      }
    }`}`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return remove ? '' : Buffer.from(result.stdout.trim(), 'base64').toString('utf8');
}

async function main(): Promise<void> {
  const diagnostics = new Diagnostics();
  const runner = new ToastProcessRunner(resolve('dist/native/JobFinish.Native.exe'), diagnostics);
  try {
    for (const icon of [false, true]) {
      const notificationId = randomUUID(), windowInstanceId = randomUUID();
      const tag = notificationId.slice(0, 16), group = windowInstanceId.slice(0, 16);
      const title = `Job-Finish · ${icon ? '아이콘 있는' : '아이콘 없는'} 긴 본문 확인`;
      const message = toastText(('작업을 완료했습니다. 긴 응답은 알림 너비에 맞춰 줄바꿈되고 네 줄을 넘으면 말줄임됩니다. '
        + '아이콘을 끄면 본문이 넓은 공간을 사용합니다. 한글과 이모지 😀도 정상적으로 표시됩니다.\n\n').repeat(20));
      assert.ok(message.includes('한글과 이모지 😀')); assert.ok(!message.includes('?'));
      try {
        const events: Record<string, unknown>[] = [];
        await runner.run(['--show'], { notificationId, windowInstanceId, title, message, appId,
          pipe: `job-finish-${randomUUID()}`, ...(icon ? { imagePath: resolve('resources/icon/toast-default.png') } : {}) },
        event => events.push(event)).completion;
        assert.ok(events.some(event => event.event === 'toast.history.confirmed'));
        const xml = history(tag, group);
        assert.ok(xml.includes(title)); assert.ok(xml.includes(message), 'Windows must retain the exact Korean and emoji preview');
        assert.match(xml, /hint-maxLines="2"/); assert.match(xml, /hint-maxLines="4"/);
        assert.equal(xml.includes('appLogoOverride'), icon);
        console.log(JSON.stringify({ icon, unicodePreserved: true, historyConfirmed: true, lineLimits: [2, 4], bannerVerified: false }));
      } finally { history(tag, group, true); }
    }
  } finally { runner.dispose(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });

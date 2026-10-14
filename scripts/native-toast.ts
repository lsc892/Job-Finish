import { join, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { WindowsToast } from '../src/windows/toast';
import { Diagnostics } from '../src/core/model';
import { Win32, WindowIdentity } from '../src/windows/native';
async function main(): Promise<void> {
  const diagnostics = new Diagnostics();
  const executable = process.env.JOB_FINISH_CODE_EXECUTABLE ?? join(process.env.LOCALAPPDATA!, 'Programs/Microsoft VS Code/Code.exe');
  const args = process.argv.slice(2); const hwndIndex = args.indexOf('--activate-hwnd');
  const expectClick = args.includes('--expect-click');
  const windowInstanceId = randomUUID();
  let native: Win32 | undefined; let identity: WindowIdentity | undefined;
  if (hwndIndex >= 0) {
    const value = args[hwndIndex + 1]; if (!value || !/^(?:[0-9]+|0x[0-9a-f]+)$/i.test(value)) throw new Error('--activate-hwnd requires a native window handle');
    native = new Win32(); const target = native.inspect(BigInt(value));
    if (!target) throw new Error('Requested test window does not exist or is not visible');
    // Only the explicit diagnostic target bypasses focus observation; production
    // binding continues to use VS Code focus events and a stable native HWND.
    identity = new WindowIdentity(windowInstanceId, native, () => native!.foreground() === target.hwnd, executable);
    identity.binding = { ...target, windowInstanceId, verifiedAt: new Date().toISOString(), method: 'focused-observation' };
    if (!identity.valid()) throw new Error('Requested test window is not owned by the configured VS Code executable');
  }
  const toast = new WindowsToast(WindowsToast.binary(resolve('.')), diagnostics); let clicks = 0;
  let activated: boolean | undefined;
  const events: { at: string; event: string; foreground?: string; activated?: boolean }[] = [];
  const record = (event: string) => { const entry = { at: new Date().toISOString(), event, foreground: native?.foreground().toString(), activated }; events.push(entry); console.log(JSON.stringify(entry)); };
  try {
    record('start');
    const target = identity?.valid();
    await toast.show({ notificationId: randomUUID(), windowInstanceId, appId: WindowsToast.appId,
      target: target ? { hwnd: target.hwnd.toString(), pid: target.pid, executable: target.executable } : undefined,
      title: 'Job-Finish · Verification', message: identity ? 'Click to activate the selected VS Code window.' : 'Click to verify native Windows toast delivery.', onClick: () => {
        clicks++; record('click');
        activated = [...diagnostics.events].reverse().find(entry => entry.event === 'window.activation.result')?.activated === true;
        record('activation');
      } });
    await new Promise(resolve => setTimeout(resolve, 12_000));
    const unexpectedDiagnostics = diagnostics.entries.filter(entry => identity || entry.message !== 'Native toast activation failed: missing-binding');
    const result = { invoked: true, clicked: clicks > 0, clicks, activated, target: identity?.binding?.hwnd.toString(), events,
      activationRequested: !!identity, nativeEvents: diagnostics.events, diagnostics: diagnostics.entries, visualAppearanceVerified: false };
    mkdirSync('test-artifacts', { recursive: true }); writeFileSync('test-artifacts/native-toast.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
    // The delivery-only mode deliberately has no HWND. Preserve the refusal in the artifact,
    // but require actual activation whenever --activate-hwnd was specified.
    if (unexpectedDiagnostics.length || expectClick && (clicks !== 1 || identity && activated !== true)) process.exitCode = 1;
  } finally { toast.dispose(); identity?.dispose(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });

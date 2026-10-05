import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { WindowsToast } from '../src/windows/toast';
import { Diagnostics } from '../src/core/model';
async function main(): Promise<void> {
  const diagnostics = new Diagnostics();
  const executable = process.env.JOB_FINISH_CODE_EXECUTABLE ?? join(process.env.LOCALAPPDATA!, 'Programs/Microsoft VS Code/Code.exe');
  const toast = new WindowsToast(executable, diagnostics); let clicked = false;
  try {
    await toast.show({ notificationId: randomUUID(), windowInstanceId: randomUUID(), appId: WindowsToast.appId,
      title: 'Job-Finish · Verification', message: 'Windows toast delivery test. Native visual appearance requires manual confirmation.', onClick: () => { clicked = true; } });
    await new Promise(resolve => setTimeout(resolve, 12_000));
    const result = { invoked: true, clicked, diagnostics: diagnostics.entries, visualAppearanceVerified: false };
    mkdirSync('test-artifacts', { recursive: true }); writeFileSync('test-artifacts/native-toast.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
    if (diagnostics.entries.length) process.exitCode = 1;
  } finally { toast.dispose(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });

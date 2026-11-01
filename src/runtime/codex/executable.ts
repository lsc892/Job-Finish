// 설정과 PATH에서 셸을 거치지 않고 실행할 Codex App Server 명령을 결정한다.
import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
export function codexCommand(configured = ''): { executable: string; args: string[] } {
  const paths = configured ? [configured] : (process.env.PATH ?? '').split(delimiter).flatMap(dir => [join(dir, 'codex.exe'), join(dir, 'node_modules/@openai/codex/bin/codex.js'), join(dir, 'codex')]);
  for (const path of paths) {
    if (!existsSync(path)) continue;
    if (/\.(cmd|ps1)$/i.test(path)) {
      const script = join(dirname(path), 'node_modules/@openai/codex/bin/codex.js');
      if (existsSync(script)) return { executable: process.execPath, args: [script, 'app-server'] };
      throw new Error('Use a native Codex executable or npm bin/codex.js, not a shell script');
    }
    return /\.[cm]?js$/i.test(path) ? { executable: process.execPath, args: [path, 'app-server'] } : { executable: path, args: ['app-server'] };
  }
  throw new Error('Codex executable not found. Configure jobFinish.codexExecutable.');
}

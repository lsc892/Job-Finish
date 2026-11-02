// 설정과 PATH에서 셸을 거치지 않고 실행할 Codex App Server 명령을 결정한다.
import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

const NPM_CODEX_SCRIPT = 'node_modules/@openai/codex/bin/codex.js';

export function codexCommand(configured = ''): { executable: string; args: string[] } {
  for (const path of executableCandidates(configured)) {
    if (!existsSync(path)) continue;
    return commandForPath(path);
  }
  throw new Error('Codex executable not found. Configure jobFinish.codexExecutable.');
}

// 설정 경로가 없을 때만 PATH의 디렉터리별로 native → npm JS → bare 순서로 찾는다.
function executableCandidates(configured: string): string[] {
  if (configured) return [configured];
  return (process.env.PATH ?? '').split(delimiter).flatMap(directory => [
    join(directory, 'codex.exe'),
    join(directory, NPM_CODEX_SCRIPT),
    join(directory, 'codex'),
  ]);
}

// 셸 래퍼는 인접 npm 스크립트로 바꾸고 JavaScript는 현재 Node로 실행한다.
function commandForPath(path: string): { executable: string; args: string[] } {
  if (/\.(cmd|ps1)$/i.test(path)) {
    const script = join(dirname(path), NPM_CODEX_SCRIPT);
    if (existsSync(script)) return { executable: process.execPath, args: [script, 'app-server'] };
    throw new Error('Use a native Codex executable or npm bin/codex.js, not a shell script');
  }
  if (/\.[cm]?js$/i.test(path)) return { executable: process.execPath, args: [path, 'app-server'] };
  return { executable: path, args: ['app-server'] };
}

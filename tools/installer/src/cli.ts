#!/usr/bin/env node
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { installOrUpdate } from './flow';
import { inspectLegacy } from './legacy';
import { readVSIX, VSCode } from './vscode';

const usage = `Job-Finish 설치·업데이트·레거시 제거
  job-finish-installer [install|update|uninstall] [옵션]
  npm run install:extension -- [옵션]  (저장소 루트)

  install / update  레거시 검사·정리 후 새 확장 설치 또는 이전 버전 업데이트
  uninstall         기존 PowerShell/C# 레거시만 제거
  --vsix <경로>     설치할 VSIX (기본: 배포 패키지에 포함된 VSIX)
  --dry-run         상태와 처리 계획만 표시
  --project <경로>  레거시 프로젝트 경로 (기본: 명령을 호출한 폴더)
  --code <경로>     Code.exe 또는 code.cmd 경로
  --profile <이름>  설치·조회할 VS Code 프로필
  --user-data-dir <경로> / --extensions-dir <경로>  VS Code 저장 위치
  --keep-files      uninstall에서 훅만 제거하고 파일·Windows 등록 유지
  --help            도움말 표시`;

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) { console.log(usage); return; }
  const command = args[0] && !args[0].startsWith('-') ? args.shift()! : 'install';
  if (!['install', 'update', 'uninstall'].includes(command)) throw new Error(`지원하지 않는 명령: ${command}\n${usage}`);
  const caller = resolve(process.env.INIT_CWD ?? process.cwd());
  let project = caller;
  let vsix = resolve(__dirname, '../assets/job-finish-win32-x64.vsix');
  let dryRun = false;
  let keepFiles = false;
  const code: { executable?: string; profile?: string; userDataDir?: string; extensionsDir?: string } = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--dry-run') { dryRun = true; continue; }
    if (arg === '--keep-files') { keepFiles = true; continue; }
    if (!['--project', '--vsix', '--code', '--profile', '--user-data-dir', '--extensions-dir'].includes(arg!)) throw new Error(`지원하지 않는 인수: ${arg}\n${usage}`);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`${arg}에 값을 지정하세요.`);
    if (arg === '--project') project = resolve(caller, value);
    if (arg === '--vsix') vsix = resolve(caller, value);
    if (arg === '--code') code.executable = resolve(caller, value);
    if (arg === '--profile') code.profile = value;
    if (arg === '--user-data-dir') code.userDataDir = resolve(caller, value);
    if (arg === '--extensions-dir') code.extensionsDir = resolve(caller, value);
  }
  if (process.platform !== 'win32') throw new Error('이 제거 명령은 Windows 전용입니다.');
  if (keepFiles && command !== 'uninstall') throw new Error('--keep-files는 uninstall에서만 사용할 수 있습니다.');
  // Old versions used the default home even when the runtime had a custom config home.
  const claudeHome = process.env.CLAUDE_CONFIG_DIR;
  const codexHome = process.env.CODEX_HOME;
  const legacyOptions = { home: homedir(), project, keepFiles,
    claudeHome: claudeHome && existsSync(claudeHome) ? claudeHome : undefined,
    codexHome: codexHome && existsSync(codexHome) ? codexHome : undefined };
  if (command === 'uninstall') {
    const legacy = inspectLegacy(legacyOptions);
    for (const target of legacy.targets) console.log(`훅 제거 / 레거시 정리 대상: ${target}`);
    if (dryRun) { console.log('미리보기 완료. 변경한 항목이 없습니다.'); return; }
    for (const backup of legacy.remove()) console.log(`설정 백업: ${backup}`);
    console.log('기존 Job-Finish 정리 완료.');
    console.log('npm 전역 패키지도 설치했다면 별도로 실행: npm rm -g job-finish');
    return;
  }
  const vscode = new VSCode(code);
  installOrUpdate(vsix, dryRun, { readPackage: readVSIX,
    installedVersion: id => vscode.installedVersion(id), validateCompatibility: extension => vscode.validateCompatibility(extension),
    inspectLegacy: () => inspectLegacy(legacyOptions), install: path => vscode.install(path) });
}

try { main(); }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }

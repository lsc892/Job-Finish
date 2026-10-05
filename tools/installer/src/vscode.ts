import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { delimiter, dirname, extname, join, resolve } from 'node:path';
import { gt, satisfies, valid, validRange } from 'semver';
import type { ExtensionPackage } from './flow';

export interface CodeOptions { executable?: string; profile?: string; userDataDir?: string; extensionsDir?: string }
export interface CodeCommand { executable: string; args: string[] }

/** Run the Node CLI inside Code.exe directly; user paths never enter cmd.exe. */
export function resolveCode(executable?: string): CodeCommand {
  const candidate = executable ?? (process.env.PATH ?? '').split(delimiter)
    .map(dir => join(dir.replace(/^"|"$/g, ''), 'code.cmd')).find(path => existsSync(path));
  if (!candidate) throw new Error('VS Code 실행 파일을 찾지 못했습니다. --code로 Code.exe 또는 code.cmd 경로를 지정하세요.');
  const path = resolve(candidate);
  let code: string;
  let script: string;
  if (extname(path).toLowerCase() === '.cmd') {
    const launcher = readFileSync(path, 'utf8');
    const relativeCli = launcher.match(/%~dp0\.\.\\([^"\r\n]+cli\.js)/)?.[1];
    if (!relativeCli) throw new Error(`VS Code CLI 경로를 확인하지 못했습니다: ${path}`);
    code = join(dirname(dirname(path)), 'Code.exe');
    script = join(dirname(dirname(path)), relativeCli);
  } else if (extname(path).toLowerCase() === '.exe') {
    code = path; script = join(dirname(path), 'resources', 'app', 'out', 'cli.js');
  } else throw new Error('--code는 Code.exe 또는 code.cmd 경로여야 합니다.');
  if (!existsSync(code) || !existsSync(script)) throw new Error(`VS Code CLI 파일이 없습니다: ${code}`);
  return { executable: code, args: [script] };
}

export function parseInstalledVersion(output: string, id: string): string | null {
  let version: string | null = null;
  for (const line of output.split(/\r?\n/)) {
    const index = line.lastIndexOf('@');
    if (line.slice(0, index).toLowerCase() !== id.toLowerCase()) continue;
    const value = line.slice(index + 1).trim();
    if (!valid(value)) throw new Error(`설치된 확장 버전을 확인하지 못했습니다: ${line}`);
    if (version === null || gt(value, version)) version = value;
  }
  return version;
}

export class VSCode {
  private readonly command: CodeCommand;
  private readonly scope: string[] = [];
  constructor(options: CodeOptions) {
    this.command = resolveCode(options.executable);
    for (const [flag, value] of [['--profile', options.profile], ['--user-data-dir', options.userDataDir], ['--extensions-dir', options.extensionsDir]]) {
      if (value) this.scope.push(flag!, value);
    }
  }
  private run(args: string[]): string {
    return execFileSync(this.command.executable, [...this.command.args, ...this.scope, ...args],
      { encoding: 'utf8', windowsHide: true, timeout: 120_000,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', VSCODE_CLI: '1' }, maxBuffer: 4 * 1024 * 1024 }).trim();
  }
  installedVersion(id: string): string | null { return parseInstalledVersion(this.run(['--list-extensions', '--show-versions']), id); }
  validateCompatibility(extension: ExtensionPackage): void {
    const version = this.run(['--version']).split(/\r?\n/)[0]?.trim();
    if (!version || !valid(version) || !validRange(extension.vscodeEngine) || !satisfies(version, extension.vscodeEngine)) {
      throw new Error(`VS Code 버전이 맞지 않습니다. 설치됨: ${version}, 필요: ${extension.vscodeEngine}`);
    }
  }
  install(path: string): void { this.run(['--install-extension', resolve(path), '--force']); }
}

/** Read the version from the actual VSIX, rather than the installer's npm version. */
export function readVSIX(path: string): ExtensionPackage {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`VSIX 파일이 없습니다: ${path}\n--vsix로 파일을 지정하거나 설치 도구에 VSIX를 포함해 빌드하세요.`);
  let output: string;
  try { output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
    $ErrorActionPreference = 'Stop'
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($env:JOB_FINISH_VSIX_PATH)
    try {
      $entry = $zip.GetEntry('extension/package.json')
      if ($null -eq $entry -or $null -eq $zip.GetEntry('extension.vsixmanifest')) { throw 'Invalid VSIX manifest.' }
      if ($entry.Length -gt 1048576) { throw 'VSIX manifest too large.' }
      $reader = [IO.StreamReader]::new($entry.Open())
      try { $manifest = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
      if ($manifest.main -and $null -eq $zip.GetEntry('extension/' + $manifest.main.Replace('./', ''))) { throw 'Missing extension entry point.' }
      @{ id = $manifest.publisher + '.' + $manifest.name; version = $manifest.version; vscodeEngine = $manifest.engines.vscode } | ConvertTo-Json -Compress
    } finally { $zip.Dispose() }
  `], { encoding: 'utf8', stdio: 'pipe', windowsHide: true, timeout: 10_000, env: { ...process.env, JOB_FINISH_VSIX_PATH: resolve(path) } }); }
  catch (error) { throw new Error(`VSIX 파일을 읽지 못했습니다: ${path}`, { cause: error }); }
  const value = JSON.parse(output) as ExtensionPackage;
  if (typeof value.id !== 'string' || !valid(value.version) || typeof value.vscodeEngine !== 'string') throw new Error('VSIX 메타데이터가 올바르지 않습니다.');
  return value;
}

import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';

export const FOCUS_PROTOCOL = 'HKCU\\Software\\Classes\\jobfinish-focus';
export interface WindowsResidue { protocolCommand: string | null; shortcut: string | null }

function powershell(command: string, env = process.env): string {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
    { encoding: 'utf8', windowsHide: true, timeout: 10_000, env }).trim();
}

/** Read only the legacy tool's named protocol and Start Menu shortcut. */
export function inspectWindowsResidue(): WindowsResidue {
  const output = powershell(`
    $ErrorActionPreference = 'Stop'
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    $key = 'HKCU:\\Software\\Classes\\jobfinish-focus\\shell\\open\\command'
    $command = if (Test-Path -LiteralPath $key) { (Get-Item -LiteralPath $key).GetValue('') } else { $null }
    if ($command -notmatch '(?i)(jf-focus-vscode\\.exe|Focus-VSCode\\.ps1)') { $command = $null }
    $shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'Job-Finish\\Visual Studio Code.lnk'
    if (Test-Path -LiteralPath $shortcut) {
      $link = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcut)
      if (($link.TargetPath + ' ' + $link.Arguments) -notmatch '(?i)(jf-focus-vscode\\.exe|Focus-VSCode\\.ps1)') { $shortcut = $null }
    } else { $shortcut = $null }
    @{ protocolCommand = $command; shortcut = $shortcut } | ConvertTo-Json -Compress
  `);
  return JSON.parse(output) as WindowsResidue;
}

export function removeWindowsResidue(residue: WindowsResidue): void {
  if (residue.protocolCommand) powershell(`
    $ErrorActionPreference = 'Stop'
    $base = 'HKCU:\\Software\\Classes\\jobfinish-focus'
    $key = $base + '\\shell\\open\\command'
    if ((Get-Item -LiteralPath $key).GetValue('') -cne $env:JOB_FINISH_EXPECTED_PROTOCOL) { throw 'Protocol changed; rerun cleanup.' }
    Remove-Item -LiteralPath $base -Recurse -Force
  `, { ...process.env, JOB_FINISH_EXPECTED_PROTOCOL: residue.protocolCommand });
  if (residue.shortcut) rmSync(residue.shortcut, { force: true });
}

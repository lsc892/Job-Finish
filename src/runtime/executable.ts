import { existsSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
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
export function runtimeId(provider: 'codex' | 'claude'): string {
  const home = provider === 'codex' ? process.env.CODEX_HOME ?? join(homedir(), '.codex') : process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  const canonical = existsSync(home) ? realpathSync.native(home) : resolve(home);
  return createHash('sha256').update(JSON.stringify([provider, process.platform === 'win32' ? canonical.toLowerCase() : canonical])).digest('hex');
}

import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
const native = spawnSync('dotnet', ['publish', 'tools/windows-toast/JobFinish.Native.csproj', '-c', 'Release', '-o', 'dist/native', '--nologo'], { stdio: 'inherit', windowsHide: true });
if (native.error) throw native.error;
if (native.status !== 0) throw new Error(`Native helper publish failed: ${native.status}`);
await build({ entryPoints: ['src/extension.ts'], outfile: 'dist/extension.cjs',
  bundle: true, platform: 'node', format: 'cjs', target: 'node22', sourcemap: true,
  external: ['vscode', 'koffi', '@anthropic-ai/claude-agent-sdk'] });

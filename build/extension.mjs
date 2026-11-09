// Windows 알림 도우미를 게시하고 VS Code 확장 진입점을 번들링한다.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
if (process.argv.slice(2).some(arg => arg !== '--diagnostics')) throw new Error('Unknown build option');
const diagnostics = process.argv.includes('--diagnostics');
const output = diagnostics ? 'dist-diagnostics' : 'dist';
const native = spawnSync('dotnet', ['publish', 'tools/windows-toast/JobFinish.Native.csproj', '-c', 'Release', '-o', `${output}/native`, '--nologo'], { stdio: 'inherit', windowsHide: true });
if (native.error) throw native.error;
if (native.status !== 0) throw new Error(`Native helper publish failed: ${native.status}`);
if (!diagnostics) await rm('dist/extension.cjs.map', { force: true });
await build({ entryPoints: ['src/extension.ts'], outfile: `${output}/extension.cjs`,
  bundle: true, platform: 'node', format: 'cjs', target: 'node22', sourcemap: diagnostics,
  // diagnostic 라벨의 처리와 인수 평가를 일반 빌드에서 제거하고 진단 빌드에서만 유지한다.
  dropLabels: diagnostics ? [] : ['diagnostic'],
  external: ['vscode', 'koffi'] });
console.log(`Job-Finish: ${diagnostics ? 'diagnostic' : 'production'} build → ${output}/extension.cjs`);

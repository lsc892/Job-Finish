import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const requireVSIX = args.length === 1 && args[0] === '--require-vsix';
if (args.length && !requireVSIX) {
  if (args.length !== 2 || args[0] !== '--vsix') throw new Error('Use build --vsix <path>');
  const source = resolve(args[1]);
  if (!existsSync(source)) throw new Error(`VSIX missing: ${source}`);
  mkdirSync(resolve(root, 'assets'), { recursive: true });
  const target = resolve(root, 'assets/job-finish-win32-x64.vsix');
  if (source !== target) copyFileSync(source, target);
}
if (requireVSIX && !existsSync(resolve(root, 'assets/job-finish-win32-x64.vsix'))) {
  throw new Error('Build with --vsix <path> before packing the installer.');
}
await build({ entryPoints: [resolve(root, 'src/cli.ts')], outfile: resolve(root, 'dist/cli.cjs'),
  bundle: true, platform: 'node', format: 'cjs', target: 'node22' });

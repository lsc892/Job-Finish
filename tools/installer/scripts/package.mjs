// 공통 README와 현재 VSIX를 npm 배포 전용 폴더에 모아 패키징한다.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repository = resolve(root, '../..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const extension = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8'));
if (manifest.name !== 'job-finish' || extension.publisher !== 'JobFinish' || extension.name !== 'JobFinish'
  || manifest.version !== extension.version) throw new Error('Align npm and JobFinish.JobFinish release identities and versions before packaging.');
if (!process.env.npm_execpath) throw new Error('Run npm run package:npm from the repository root.');

const built = spawnSync(process.execPath, [join(root, 'scripts/build.mjs'), '--vsix', join(repository, 'job-finish-win32-x64.vsix')],
  { cwd: root, stdio: 'inherit', windowsHide: true });
if (built.error) throw built.error;
if (built.status !== 0) throw new Error(`Installer build failed: ${built.status}`);

const stage = mkdtempSync(join(tmpdir(), 'job-finish-npm-'));
for (const file of ['dist/cli.cjs', 'assets/job-finish-win32-x64.vsix', 'LICENSE']) {
  mkdirSync(dirname(join(stage, file)), { recursive: true });
  copyFileSync(join(root, file), join(stage, file));
}
// 배포물은 빌드가 끝난 CLI와 VSIX를 제공하므로 저장소 전용 스크립트는 넣지 않는다.
const { scripts, ...publishedManifest } = manifest;
writeFileSync(join(stage, 'package.json'), JSON.stringify(publishedManifest, null, 2) + '\n');

const github = extension.repository.url.replace(/^git\+/, '').replace(/\.git$/, '').replace(/\/$/, '');
const absolute = (url, base) => /^(?:[a-z][a-z\d+.-]*:|#|\/)/i.test(url) ? url : new URL(url, base).href;
const readme = readFileSync(join(repository, 'README.md'), 'utf8')
  .replace(/(\]\()([^\s)]+)(\))/g, (_match, open, url, close) => `${open}${absolute(url, `${github}/blob/HEAD/`)}${close}`)
  .replace(/(\bsrc=["'])([^"']+)(["'])/g, (_match, open, url, close) => `${open}${absolute(url, `${github.replace('github.com', 'raw.githubusercontent.com')}/HEAD/`)}${close}`);
writeFileSync(join(stage, 'README.md'), readme);

const packed = spawnSync(process.execPath, [process.env.npm_execpath, 'pack', stage, '--pack-destination', repository, '--json'],
  { cwd: repository, encoding: 'utf8', windowsHide: true });
if (packed.error) throw packed.error;
if (packed.stderr) process.stderr.write(packed.stderr);
if (packed.status !== 0) throw new Error(`npm pack failed: ${packed.status}`);
process.stdout.write(packed.stdout);

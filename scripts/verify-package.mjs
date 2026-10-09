import { createRequire } from 'node:module';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const root = mkdtempSync(join(tmpdir(), 'job-finish-package-'));
const cli = process.env.JOB_FINISH_CODE_EXECUTABLE ?? join(process.env.LOCALAPPDATA, 'Programs/Microsoft VS Code/Code.exe');
// Invoke VS Code's Node CLI directly, no cmd.exe interpolation of file paths.
const launcher = readFileSync(join(dirname(cli), 'bin/code.cmd'), 'utf8');
const relativeCli = launcher.match(/%~dp0\.\.\\([^"\r\n]+cli\.js)/)?.[1];
const cliScript = join(dirname(cli), relativeCli ?? 'resources/app/out/cli.js');
const { stdout } = await promisify(execFile)(cli, [cliScript, '--user-data-dir', join(root, 'profile'), '--extensions-dir', join(root, 'extensions'), '--install-extension', resolve('job-finish-win32-x64.vsix'), '--force'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', VSCODE_CLI: '1' }, windowsHide: true, timeout: 60_000 });
console.log(stdout.trim());
const installed = JSON.parse(readFileSync(join(root, 'extensions/extensions.json'), 'utf8')).find(entry => entry.identifier.id === 'lsc892.job-finish');
if (!installed) throw new Error('Extension installation not registered');
const extension = join(root, 'extensions', installed.relativeLocation);
if (!existsSync(join(extension, 'dist/extension.cjs'))) throw new Error('Packaged extension entry point missing');
for (const file of ['dist/extension.cjs', 'dist/native/JobFinish.Native.exe']) {
  if (!readFileSync(join(extension, file)).equals(readFileSync(resolve(file)))) throw new Error(`VSIX contains a stale build: ${file}`);
}
const requireFromExtension = createRequire(join(extension, 'package.json'));
const koffi = requireFromExtension('koffi'); koffi.load('user32.dll');
const sdkEntry = requireFromExtension.resolve('@anthropic-ai/claude-agent-sdk');
const sdk = await import(pathToFileURL(sdkEntry).href); if (typeof sdk.query !== 'function') throw new Error('SDK unavailable');
for (const file of ['dist/native/JobFinish.Native.exe', 'node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe', 'docs/verification.md']) {
  if (!existsSync(join(extension, file))) throw new Error(`VSIX missing ${file}`);
}
const helper = join(extension, 'dist/native/JobFinish.Native.exe');
// Start the bundled self-contained helper without changing protocol registration.
let helperStarted = false;
try { await promisify(execFile)(helper, [], { windowsHide: true, timeout: 15_000 }); }
catch (error) { if (error.code !== 2) throw error; helperStarted = true; }
if (!helperStarted) throw new Error('Native helper did not return its no-arguments exit code');
const result = { installed: true, nativeLoaded: true, sdkLoaded: true, nativeToastHelperIncluded: true, extension, totalScope: 'isolated profile; user extensions unchanged' };
mkdirSync('test-artifacts', { recursive: true }); writeFileSync('test-artifacts/package.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));

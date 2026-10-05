import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXTENSION_ID, installOrUpdate, planInstall, type InstallServices } from '../src/flow';
import { applyLegacyUninstall, planLegacyUninstall } from '../src/uninstall';
import { parseInstalledVersion } from '../src/vscode';

for (const [legacy, installed, state, action] of [
  [false, null, 'empty', 'install'], [true, null, 'legacy', 'install'],
  [false, '0.0.9', 'current', 'update'], [true, '0.0.9', 'both', 'update']
] as const) {
  test(`Installation flow: ${state} -> ${action}, legacy cleanup=${legacy}`, t => {
    const root = mkdtempSync(join(tmpdir(), 'job-finish-flow-')); t.after(() => rmSync(root, { recursive: true, force: true }));
    const home = join(root, 'home'); const project = join(root, 'project'); mkdirSync(home); mkdirSync(project);
    const settings = join(home, '.claude', 'settings.json'); const install = join(home, '.job-finish');
    if (legacy) {
      mkdirSync(join(home, '.claude')); mkdirSync(install);
      writeFileSync(settings, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command',
        command: 'powershell -File "C:/user/.job-finish/job-finish-notify.ps1"' }] }] }, permissions: { allow: ['Read'] } }));
      writeFileSync(join(install, 'job-finish.config.json'), '{"flashTimeout":"5m"}');
    }
    let current: string | null = installed;
    const calls: string[] = [];
    let backups: string[] = [];
    const services: InstallServices = {
      readPackage: () => ({ id: EXTENSION_ID, version: '0.1.0', vscodeEngine: '^1.99.0' }),
      installedVersion: () => current,
      validateCompatibility: () => { calls.push('validate'); },
      inspectLegacy: () => {
        const plan = planLegacyUninstall({ home, project });
        return { found: !!(plan.configs.length || plan.directories.length), targets: [install], remove() {
          calls.push('cleanup'); backups = applyLegacyUninstall(plan); return backups;
        } };
      },
      install: path => { assert.equal(path, 'new.vsix'); assert.equal(existsSync(install), false);
        calls.push('install'); current = '0.1.0'; }
    };
    const plan = installOrUpdate('new.vsix', false, services, () => {});
    assert.equal(plan.state, state); assert.equal(plan.action, action);
    assert.deepEqual(calls, legacy ? ['validate', 'cleanup', 'install'] : ['validate', 'install']);
    if (legacy) {
      assert.equal(backups.length, 2);
      assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')), { permissions: { allow: ['Read'] } });
      assert.ok(backups.every(path => existsSync(path)));
    }
    calls.length = 0;
    const repeat = installOrUpdate('new.vsix', false, services, () => {});
    assert.equal(repeat.action, 'unchanged'); assert.equal(repeat.removeLegacy, false); assert.deepEqual(calls, []);
  });
}

test('Same or newer extensions are preserved, while remaining legacy files are still cleaned', () => {
  for (const installed of ['0.1.0', '0.10.0']) {
    const calls: string[] = [];
    const services: InstallServices = {
      readPackage: () => ({ id: EXTENSION_ID, version: '0.1.0', vscodeEngine: '^1.99.0' }),
      installedVersion: () => installed, validateCompatibility: () => { calls.push('validate'); },
      inspectLegacy: () => ({ found: true, targets: ['legacy'], remove: () => { calls.push('cleanup'); return []; } }),
      install: () => { calls.push('install'); }
    };
    assert.equal(installOrUpdate('new.vsix', false, services, () => {}).action, 'unchanged');
    assert.deepEqual(calls, ['cleanup']);
  }
  assert.equal(planInstall('0.9.0', '0.10.0', false).action, 'update');
  assert.equal(planInstall('1.0.0-beta.1', '1.0.0', false).action, 'update');
});

test('Dry-run, invalid package, unsupported VS Code and failed cleanup never mutate the installation', () => {
  const calls: string[] = [];
  const services: InstallServices = {
    readPackage: () => ({ id: EXTENSION_ID, version: '0.1.0', vscodeEngine: '^1.99.0' }),
    installedVersion: () => null, validateCompatibility: () => {},
    inspectLegacy: () => ({ found: true, targets: ['legacy'], remove: () => { calls.push('cleanup'); return []; } }),
    install: () => { calls.push('install'); }
  };
  assert.equal(installOrUpdate('new.vsix', true, services, () => {}).state, 'legacy'); assert.deepEqual(calls, []);
  assert.throws(() => installOrUpdate('new.vsix', false, { ...services,
    readPackage: () => { throw new Error('invalid ZIP'); } }, () => {}), /invalid ZIP/);
  assert.throws(() => installOrUpdate('new.vsix', false, { ...services,
    readPackage: () => ({ id: 'another.extension', version: '1.0.0', vscodeEngine: '*' }) }, () => {}), /Job-Finish VSIX/);
  assert.throws(() => installOrUpdate('new.vsix', false, { ...services,
    validateCompatibility: () => { throw new Error('unsupported VS Code'); } }, () => {}), /unsupported VS Code/);
  assert.deepEqual(calls, []);
  assert.throws(() => installOrUpdate('new.vsix', false, { ...services,
    inspectLegacy: () => ({ found: true, targets: ['legacy'], remove: () => { throw new Error('backup failed'); } }) }, () => {}), /backup failed/);
  assert.deepEqual(calls, []);
});

test('Failed VS Code installation or unexpected resulting version is reported as a failure', () => {
  const services: InstallServices = {
    readPackage: () => ({ id: EXTENSION_ID, version: '0.1.0', vscodeEngine: '^1.99.0' }),
    installedVersion: () => null, validateCompatibility: () => {},
    inspectLegacy: () => ({ found: false, targets: [], remove: () => [] }),
    install: () => { throw new Error('installation failed'); }
  };
  assert.throws(() => installOrUpdate('new.vsix', false, services, () => {}), /installation failed/);
  assert.throws(() => installOrUpdate('new.vsix', false, { ...services, install: () => {} }, () => {}), /설치 결과/);
});

test('Extension listing ignores other IDs and logs; malformed installed versions fail closed', () => {
  assert.equal(parseInstalledVersion('warning\r\nother.job-finish@2.0.0\r\nlsc892.job-finish@0.9.0\r\nlsc892.job-finish@0.10.0\r\n', EXTENSION_ID), '0.10.0');
  assert.equal(parseInstalledVersion('other.job-finish@1.0.0', EXTENSION_ID), null);
  assert.throws(() => parseInstalledVersion('lsc892.job-finish@broken', EXTENSION_ID), /버전/);
});

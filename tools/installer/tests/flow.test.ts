import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXTENSION_ID, installOrUpdate, planInstall, uninstall, type InstallServices, type UninstallServices } from '../src/flow';
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

for (const [installed, legacy] of [[null, false], [null, true], ['0.1.0', false], ['0.1.0', true]] as const) {
  test(`Uninstall removes only installed targets and is repeatable: extension=${installed}, legacy=${legacy}`, () => {
    let current: string | null = installed;
    let legacyPresent: boolean = legacy;
    const calls: string[] = [];
    const services: UninstallServices = {
      installedVersion: id => { assert.equal(id, EXTENSION_ID); return current; },
      inspectLegacy: () => ({ found: legacyPresent, targets: legacyPresent ? ['legacy'] : [], remove: () => {
        calls.push('legacy'); legacyPresent = false; return ['settings.bak'];
      } }),
      uninstall: id => { assert.equal(id, EXTENSION_ID); calls.push('extension'); current = null; }
    };
    assert.deepEqual(uninstall(false, services, () => {}), {
      installedVersion: installed, removeExtension: installed !== null, removeLegacy: legacy
    });
    assert.deepEqual(calls, [...(installed === null ? [] : ['extension']), ...(legacy ? ['legacy'] : [])]);
    calls.length = 0;
    assert.deepEqual(uninstall(false, services, () => {}), {
      installedVersion: null, removeExtension: false, removeLegacy: false
    });
    assert.deepEqual(calls, []);
  });
}

test('Uninstall dry-run inspects both targets without needing a VSIX or removing anything', () => {
  const calls: string[] = [];
  const services: UninstallServices = {
    installedVersion: () => { calls.push('inspect-extension'); return '0.1.0'; },
    inspectLegacy: () => { calls.push('inspect-legacy'); return { found: true, targets: ['legacy'],
      remove: () => { calls.push('remove-legacy'); return []; } }; },
    uninstall: () => { calls.push('remove-extension'); }
  };
  assert.deepEqual(uninstall(true, services, () => {}), {
    installedVersion: '0.1.0', removeExtension: true, removeLegacy: true
  });
  assert.deepEqual(calls, ['inspect-extension', 'inspect-legacy']);
});

test('Uninstall inspection failures prevent mutations; extension failures preserve legacy settings', () => {
  const calls: string[] = [];
  const services: UninstallServices = {
    installedVersion: () => '0.1.0',
    inspectLegacy: () => ({ found: true, targets: ['legacy'], remove: () => { calls.push('legacy'); return []; } }),
    uninstall: () => { calls.push('extension'); }
  };
  assert.throws(() => uninstall(false, { ...services,
    installedVersion: () => { throw new Error('listing failed'); } }, () => {}), /listing failed/);
  assert.throws(() => uninstall(false, { ...services,
    inspectLegacy: () => { throw new Error('malformed legacy settings'); } }, () => {}), /malformed legacy settings/);
  assert.deepEqual(calls, []);
  assert.throws(() => uninstall(false, { ...services,
    uninstall: () => { throw new Error('extension removal failed'); } }, () => {}), /extension removal failed/);
  assert.deepEqual(calls, []);
  assert.throws(() => uninstall(false, services, () => {}), /확장 제거 결과/);
  assert.deepEqual(calls, ['extension']);
});

test('Uninstall reports a failed post-removal query or failed legacy cleanup', () => {
  let current: string | null = '0.1.0';
  let removed = false;
  const services: UninstallServices = {
    installedVersion: () => current,
    inspectLegacy: () => ({ found: true, targets: ['legacy'], remove: () => { throw new Error('backup failed'); } }),
    uninstall: () => { removed = true; current = null; }
  };
  assert.throws(() => uninstall(false, { ...services,
    installedVersion: () => { if (removed) throw new Error('verification failed'); return current; } }, () => {}), /verification failed/);
  removed = false; current = '0.1.0';
  assert.throws(() => uninstall(false, services, () => {}), /backup failed/);
  assert.equal(current, null);
});

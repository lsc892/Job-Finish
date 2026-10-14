import { gt, valid } from 'semver';

export const EXTENSION_ID = 'JobFinish.JobFinish';
export interface ExtensionPackage { id: string; version: string; vscodeEngine: string }
export interface LegacyInstallation {
  found: boolean;
  targets: string[];
  remove(): string[];
}
export interface InstallServices {
  readPackage(path: string): ExtensionPackage;
  installedVersion(id: string): string | null;
  validateCompatibility(extension: ExtensionPackage): void;
  inspectLegacy(): LegacyInstallation;
  install(path: string): void;
}
export interface InstallPlan {
  state: 'empty' | 'legacy' | 'current' | 'both';
  action: 'install' | 'update' | 'unchanged';
  installedVersion: string | null;
  targetVersion: string;
  removeLegacy: boolean;
}
export interface UninstallServices {
  installedVersion(id: string): string | null;
  inspectLegacy(): LegacyInstallation;
  uninstall(id: string): void;
}
export interface UninstallPlan {
  installedVersion: string | null;
  removeExtension: boolean;
  removeLegacy: boolean;
}

export function planInstall(installed: string | null, target: string, legacy: boolean): InstallPlan {
  if (!valid(target) || (installed !== null && !valid(installed))) throw new Error('확장 버전이 올바르지 않습니다.');
  return {
    state: installed === null ? legacy ? 'legacy' : 'empty' : legacy ? 'both' : 'current',
    action: installed === null ? 'install' : gt(target, installed) ? 'update' : 'unchanged',
    installedVersion: installed, targetVersion: target, removeLegacy: legacy
  };
}

/** Validate the package and VS Code before removing any legacy installation. */
export function installOrUpdate(path: string, dryRun: boolean, services: InstallServices,
  log: (message: string) => void = console.log): InstallPlan {
  const extension = services.readPackage(path);
  if (extension.id.toLowerCase() !== EXTENSION_ID.toLowerCase()) throw new Error(`Job Finish VSIX가 아닙니다: ${extension.id}`);
  const installed = services.installedVersion(EXTENSION_ID);
  const legacy = services.inspectLegacy();
  const plan = planInstall(installed, extension.version, legacy.found);
  if (plan.action !== 'unchanged') services.validateCompatibility(extension);
  const states = { empty: '설치된 버전 없음', legacy: 'C# 레거시 있음', current: '현재 확장 있음', both: '레거시와 현재 확장 모두 있음' };
  log(`발견한 상태: ${states[plan.state]}`);
  log(`현재 확장: ${installed ?? '없음'} / 설치 패키지: ${extension.version}`);
  if (legacy.found) for (const target of legacy.targets) log(`레거시 정리 대상: ${target}`);
  log(plan.action === 'install' ? '처리: 새 확장 설치' : plan.action === 'update' ? '처리: 현재 확장 업데이트' : '처리: 같은 버전 또는 더 최신 버전이므로 확장 설치 생략');
  if (dryRun) { log('미리보기 완료. 변경한 항목이 없습니다.'); return plan; }
  if (legacy.found) {
    for (const backup of legacy.remove()) log(`설정 백업: ${backup}`);
    log('C# 레거시 정리 완료.');
  }
  if (plan.action !== 'unchanged') {
    services.install(path);
    const actual = services.installedVersion(EXTENSION_ID);
    if (actual !== extension.version) throw new Error(`설치 결과를 확인하지 못했습니다. 기대 버전: ${extension.version}, 확인 버전: ${actual ?? '없음'}`);
    log(`확장 ${plan.action === 'install' ? '설치' : '업데이트'} 완료: ${actual}`);
  }
  return plan;
}

/** Inspect all targets first; a failed extension removal leaves legacy settings untouched. */
export function uninstall(dryRun: boolean, services: UninstallServices,
  log: (message: string) => void = console.log): UninstallPlan {
  const installedVersion = services.installedVersion(EXTENSION_ID);
  const legacy = services.inspectLegacy();
  const plan = { installedVersion, removeExtension: installedVersion !== null, removeLegacy: legacy.found };
  log(`현재 확장: ${installedVersion ?? '없음'}`);
  if (legacy.found) for (const target of legacy.targets) log(`훅 제거 / 레거시 정리 대상: ${target}`);
  log(plan.removeExtension ? '처리: VS Code 확장 제거' : '처리: VS Code 확장이 설치되어 있지 않아 확장 제거 생략');
  if (dryRun) { log('미리보기 완료. 변경한 항목이 없습니다.'); return plan; }
  if (plan.removeExtension) {
    services.uninstall(EXTENSION_ID);
    const actual = services.installedVersion(EXTENSION_ID);
    if (actual !== null) throw new Error(`확장 제거 결과를 확인하지 못했습니다. 남아 있는 버전: ${actual}`);
    log('VS Code 확장 제거 완료.');
  }
  if (legacy.found) {
    for (const backup of legacy.remove()) log(`설정 백업: ${backup}`);
    log('PowerShell/C# 레거시 정리 완료.');
  }
  log('Job Finish 제거 완료. npm 전역 패키지도 제거하려면: npm rm -g job-finish');
  return plan;
}

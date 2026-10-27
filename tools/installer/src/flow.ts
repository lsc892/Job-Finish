// 설치 상태와 버전을 비교해 레거시 정리·확장 설치·결과 확인을 조율한다.
import { gt, valid } from 'semver';

export const EXTENSION_ID = 'lsc892.job-finish';
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

export function planInstall(installed: string | null, target: string, legacy: boolean): InstallPlan {
  if (!valid(target) || (installed !== null && !valid(installed))) throw new Error('확장 버전이 올바르지 않습니다.');
  if (installed === null) {
    return { state: legacy ? 'legacy' : 'empty', action: 'install',
      installedVersion: installed, targetVersion: target, removeLegacy: legacy };
  }
  return {
    state: legacy ? 'both' : 'current',
    action: gt(target, installed) ? 'update' : 'unchanged',
    installedVersion: installed, targetVersion: target, removeLegacy: legacy
  };
}

/** Validate the package and VS Code before removing any legacy installation. */
export function installOrUpdate(path: string, dryRun: boolean, services: InstallServices,
  log: (message: string) => void = console.log): InstallPlan {
  const extension = services.readPackage(path);
  if (extension.id.toLowerCase() !== EXTENSION_ID) throw new Error(`Job-Finish VSIX가 아닙니다: ${extension.id}`);
  const installed = services.installedVersion(EXTENSION_ID);
  const legacy = services.inspectLegacy();
  const plan = planInstall(installed, extension.version, legacy.found);
  if (plan.action !== 'unchanged') services.validateCompatibility(extension);
  const states = { empty: '설치된 버전 없음', legacy: 'C# 레거시 있음', current: '현재 확장 있음', both: '레거시와 현재 확장 모두 있음' };
  log(`발견한 상태: ${states[plan.state]}`);
  log(`현재 확장: ${installed ?? '없음'} / 설치 패키지: ${extension.version}`);
  if (legacy.found) for (const target of legacy.targets) log(`레거시 정리 대상: ${target}`);
  const actions = { install: '처리: 새 확장 설치', update: '처리: 현재 확장 업데이트', unchanged: '처리: 같은 버전 또는 더 최신 버전이므로 확장 설치 생략' };
  log(actions[plan.action]);
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

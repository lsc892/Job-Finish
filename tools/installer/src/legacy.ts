import { applyLegacyUninstall, planLegacyUninstall, type LegacyUninstallOptions } from './uninstall';
import { FOCUS_PROTOCOL, inspectWindowsResidue, removeWindowsResidue } from './windows';
import type { LegacyInstallation } from './flow';

export function inspectLegacy(options: LegacyUninstallOptions): LegacyInstallation {
  const plan = planLegacyUninstall(options);
  const windows = options.keepFiles ? { protocolCommand: null, shortcut: null } : inspectWindowsResidue();
  const targets = [...plan.configs.map(edit => edit.target.path), ...plan.directories.map(dir => dir.path)];
  if (windows.protocolCommand) targets.push(FOCUS_PROTOCOL);
  if (windows.shortcut) targets.push(windows.shortcut);
  return { found: targets.length > 0, targets, remove() {
    const backups = applyLegacyUninstall(plan);
    removeWindowsResidue(windows);
    return backups;
  } };
}

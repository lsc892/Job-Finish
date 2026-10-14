import TOML from '@iarna/toml';
import { copyFileSync, lstatSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface LegacyUninstallOptions {
  home: string;
  project: string;
  claudeHome?: string;
  codexHome?: string;
  keepFiles?: boolean;
}
interface Target { root: string; parts: string[]; path: string }
interface ConfigEdit { target: Target; before: string; after: string }
export interface LegacyUninstallPlan {
  configs: ConfigEdit[];
  directories: Target[];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function notifierPath(value: unknown): boolean {
  return typeof value === 'string' && /(?:^|[\\/])job-finish-notify\.ps1$/i.test(value);
}

function notifierCommand(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const file = value.match(/(?:^|\s)-File\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i);
  const script = file?.[1] ?? file?.[2] ?? file?.[3];
  if (notifierPath(script)) return true;
  // The shared timer also runs other tools; only Job-Finish's two targets belong to us.
  if (!script || !/(?:^|[\\/])\.claude-hooklog[\\/]hook-timer\.ps1$/i.test(script)) return false;
  const target = value.match(/(?:^|\s)-Target\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i);
  return /^(?:jfstop|jfnotify)$/i.test(target?.[1] ?? target?.[2] ?? target?.[3] ?? '');
}

// Remove individual handlers, since user hooks can share the same matcher group.
function removeHooks(config: Record<string, unknown>): boolean {
  if (!record(config.hooks)) return false;
  let changed = false;
  for (const [event, groups] of Object.entries(config.hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = groups.flatMap(group => {
      if (!record(group) || !Array.isArray(group.hooks)) return [group];
      const handlers = group.hooks.filter(handler => !record(handler) || !notifierCommand(handler.command));
      if (handlers.length === group.hooks.length) return [group];
      changed = true;
      return handlers.length ? [{ ...group, hooks: handlers }] : [];
    });
    if (kept.length === groups.length && kept.every((group, index) => group === groups[index])) continue;
    if (kept.length) config.hooks[event] = kept;
    else delete config.hooks[event];
  }
  if (changed && !Object.keys(config.hooks).length) delete config.hooks;
  return changed;
}

function target(root: string, ...parts: string[]): Target {
  const canonicalRoot = realpathSync(root);
  const path = resolve(canonicalRoot, ...parts);
  const inside = relative(canonicalRoot, path);
  if (!inside || isAbsolute(inside) || inside === '..' || inside.startsWith(`..${sep}`)) {
    throw new Error(`Path is outside the cleanup root: ${path}`);
  }
  const result = { root: canonicalRoot, parts, path };
  checkTarget(result);
  return result;
}

function stat(path: string): ReturnType<typeof lstatSync> | undefined {
  try { return lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

// Refuse redirected children, including Windows directory junctions.
function checkTarget(value: Target): void {
  if (realpathSync(value.root) !== value.root) throw new Error(`Cleanup root changed: ${value.root}`);
  let path = value.root;
  for (const part of value.parts) {
    path = join(path, part);
    if (stat(path)?.isSymbolicLink()) throw new Error(`Refusing a symlink or junction: ${path}`);
  }
}

function installMarker(value: Target): boolean {
  return ['job-finish-notify.ps1', 'job-finish.config.json', 'jf-focus-vscode.exe'].some(name => {
    const file = stat(join(value.path, name));
    return file?.isFile() && !file.isSymbolicLink();
  });
}

/** Inspect every configuration before allowing any changes. Missing files are ignored. */
export function planLegacyUninstall(options: LegacyUninstallOptions): LegacyUninstallPlan {
  const plan: LegacyUninstallPlan = { configs: [], directories: [] };
  const settings = [target(options.home, '.claude', 'settings.json'),
    target(options.project, '.claude', 'settings.json'), target(options.project, '.claude', 'settings.local.json')];
  const codex = [target(options.home, '.codex', 'config.toml')];
  if (options.claudeHome) settings.push(target(options.claudeHome, 'settings.json'));
  if (options.codexHome) codex.push(target(options.codexHome, 'config.toml'));
  const seen = new Set<string>();
  for (const [files, format] of [[settings, 'json'], [codex, 'toml']] as const) {
    for (const file of files) {
      if (seen.has(file.path) || !stat(file.path)) continue;
      seen.add(file.path);
      const before = readFileSync(file.path, 'utf8');
      if (!before.trim()) continue;
      const content = before.replace(/^\uFEFF/, '');
      let parsed: unknown;
      try { parsed = format === 'json' ? JSON.parse(content) : TOML.parse(content); }
      catch (error) { throw new Error(`Cannot parse ${file.path}: ${String(error)}`); }
      if (!record(parsed)) throw new Error(`Expected a settings object: ${file.path}`);
      let changed = removeHooks(parsed);
      if (format === 'toml' && Array.isArray(parsed.notify)) {
        const index = parsed.notify.findIndex(arg => typeof arg === 'string' && arg.toLowerCase() === '-file');
        if (index >= 0 && notifierPath(parsed.notify[index + 1])) { delete parsed.notify; changed = true; }
      }
      if (changed) plan.configs.push({ target: file, before,
        after: format === 'json' ? `${JSON.stringify(parsed, null, 2)}\n` : TOML.stringify(parsed as TOML.JsonMap) });
    }
  }
  if (!options.keepFiles) {
    for (const dir of [target(options.home, '.job-finish'), target(options.project, '.claude', 'job-finish')]) {
      if (stat(dir.path)?.isDirectory() && installMarker(dir) && !plan.directories.some(item => item.path === dir.path)) {
        plan.directories.push(dir);
      }
    }
  }
  return plan;
}

/** Back up changed settings, remove hooks, then remove verified legacy install directories. */
export function applyLegacyUninstall(plan: LegacyUninstallPlan): string[] {
  for (const edit of plan.configs) {
    checkTarget(edit.target);
    if (readFileSync(edit.target.path, 'utf8') !== edit.before) throw new Error(`Settings changed; rerun: ${edit.target.path}`);
  }
  for (const dir of plan.directories) {
    checkTarget(dir);
    if (!installMarker(dir)) throw new Error(`Legacy installation changed; rerun: ${dir.path}`);
  }
  const backups = plan.configs.map(edit => {
    const backup = `${edit.target.path}.job-finish-${randomUUID()}.bak`;
    copyFileSync(edit.target.path, backup);
    return backup;
  });
  for (const dir of plan.directories) {
    const config = target(dir.root, ...dir.parts, 'job-finish.config.json');
    if (stat(config.path)?.isFile()) {
      const backup = `${dir.path}.config-${randomUUID()}.bak`;
      copyFileSync(config.path, backup);
      backups.push(backup);
    }
  }
  for (const edit of plan.configs) writeFileSync(edit.target.path, edit.after, 'utf8');
  for (const dir of plan.directories) {
    checkTarget(dir);
    rmSync(dir.path, { recursive: true, force: true });
  }
  return backups;
}

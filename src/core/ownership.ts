import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Checkpoint, SessionBinding, sessionKey } from './model';
import { withWindowsFileGate } from '../windows/gate';

interface RecordData { token: string; pid: number; windowInstanceId: string; key: string }
const hash = (s: string): string => createHash('sha256').update(s).digest('hex');
function read(path: string): RecordData | undefined { try { return JSON.parse(readFileSync(path, 'utf8')) as RecordData; } catch { return undefined; } }
function alive(pid: number): boolean { if (!Number.isInteger(pid) || pid <= 0) return true; try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; } }

/** A short exclusive gate serializes stale reclaim, creation and token-checked release.
 * Windows owns the gate handle lifetime; malformed owner records still fail closed. */
export class Ownership {
  private readonly root: string;
  constructor(storage: string) { this.root = join(storage, 'owners'); mkdirSync(this.root, { recursive: true }); }
  claim(binding: SessionBinding): Lease {
    // The second key also prevents resuming the same stored thread through another runtime.
    const keys = [sessionKey(binding), JSON.stringify(['saved-session', binding.provider, binding.sessionId])];
    const paths: string[] = []; const token = randomUUID();
    try {
      for (const key of keys) {
        const path = join(this.root, hash(key) + '.lock');
        this.gate(path, () => {
          if (existsSync(path)) {
            const old = read(path);
            if (!old || alive(old.pid)) throw new Error('Session is already owned by a live or unverifiable window');
            if (read(path)?.token !== old.token) throw new Error('Session owner changed during recovery');
            unlinkSync(path);
          }
          const fd = openSync(path, 'wx');
          try { writeFileSync(fd, JSON.stringify({ token, pid: process.pid, windowInstanceId: binding.windowInstanceId, key } satisfies RecordData)); }
          finally { closeSync(fd); }
        }); paths.push(path);
      }
    } catch (error) { for (const path of paths) this.release(path, token); throw error; }
    return new Lease(paths, token, () => paths.forEach(path => this.release(path, token)), join(this.root, hash(keys[0]!) + '.state.json'));
  }
  private gate(path: string, fn: () => void): void {
    const gate = path + '.gate'; let fd: number;
    if (process.platform === 'win32') { withWindowsFileGate(gate, fn); return; }
    try { fd = openSync(gate, 'wx'); } catch { throw new Error(`Ownership operation busy or interrupted. Retry; if persistent, inspect ${gate} with all Job-Finish windows closed.`); }
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid })); fn(); }
    finally { closeSync(fd); unlinkSync(gate); }
  }
  private release(path: string, token: string): void { this.gate(path, () => { if (read(path)?.token === token) unlinkSync(path); }); }
}
export class Lease {
  private released = false;
  constructor(private paths: string[], private token: string, private releaseFn: () => void, private statePath: string) {}
  valid(): boolean { return !this.released && this.paths.every(path => read(path)?.token === this.token); }
  load(): Checkpoint | undefined {
    if (!existsSync(this.statePath)) return;
    const state = JSON.parse(readFileSync(this.statePath, 'utf8')) as Checkpoint;
    if (state.version !== 1 || !Array.isArray(state.completed) || !Array.isArray(state.turns)) throw new Error('Invalid session checkpoint');
    return state;
  }
  save(state: Checkpoint): void {
    if (!this.valid()) throw new Error('Session ownership lost');
    const temp = this.statePath + '.' + this.token + '.tmp';
    writeFileSync(temp, JSON.stringify(state)); renameSync(temp, this.statePath);
  }
  release(): void { if (!this.released) { this.releaseFn(); this.released = true; } }
}

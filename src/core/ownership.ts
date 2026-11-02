// 창 사이 세션 소유권을 잠금 파일로 조율하고 체크포인트를 저장한다.
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Checkpoint, SessionBinding, sessionKey } from './model';
import { withWindowsFileGate } from '../windows/gate';

interface OwnerRecord { token: string; pid: number; windowInstanceId: string; key: string }
const hash = (s: string): string => createHash('sha256').update(s).digest('hex');
function readOwnerRecord(path: string): OwnerRecord | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as OwnerRecord;
  } catch {
    return undefined;
  }
}

function isOwnerAliveOrUnverifiable(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** 배타적 파일 잠금으로 창 사이 세션 소유권의 확보·회수·해제를 조율한다. */
export class Ownership {
  private readonly root: string;

  constructor(storage: string) {
    this.root = join(storage, 'owners');
    mkdirSync(this.root, { recursive: true });
  }

  // 런타임·세션 잠금과 저장 세션 잠금을 함께 확보해 창 간 중복 소유를 막는다.
  claim(binding: SessionBinding): Lease {
    const keys = [sessionKey(binding), JSON.stringify(['saved-session', binding.provider, binding.sessionId])];
    const token = randomUUID();
    const paths = this.claimLocks(keys, binding, token);
    const statePath = join(this.root, hash(keys[0]!) + '.state.json');
    return new Lease(paths, token, this.releaseAll.bind(this, paths, token), statePath);
  }

  private claimLocks(keys: string[], binding: SessionBinding, token: string): string[] {
    const paths: string[] = [];
    try {
      for (const key of keys) {
        paths.push(this.claimLock(key, binding, token));
      }
    } catch (error) {
      this.releaseAll(paths, token);
      throw error;
    }
    return paths;
  }

  // 세션 키의 SHA-256 해시를 파일명으로 사용해 배타 잠금을 생성한다.
  private claimLock(key: string, binding: SessionBinding, token: string): string {
    const path = join(this.root, hash(key) + '.lock');
    this.withOwnershipGate(path, this.claimUnderGate.bind(this, path, key, binding, token));
    return path;
  }

  private claimUnderGate(path: string, key: string, binding: SessionBinding, token: string): void {
    this.reclaimStaleOwner(path);
    this.writeOwner(path, { token, pid: process.pid, windowInstanceId: binding.windowInstanceId, key });
  }

  private reclaimStaleOwner(path: string): void {
    if (!existsSync(path)) return;
    const owner = readOwnerRecord(path);
    if (!owner || isOwnerAliveOrUnverifiable(owner.pid)) {
      throw new Error('Session is already owned by a live or unverifiable window');
    }
    if (readOwnerRecord(path)?.token !== owner.token) {
      throw new Error('Session owner changed during recovery');
    }
    unlinkSync(path);
  }

  private writeOwner(path: string, record: OwnerRecord): void {
    const fd = openSync(path, 'wx');
    try {
      writeFileSync(fd, JSON.stringify(record));
    } finally {
      closeSync(fd);
    }
  }

  private withOwnershipGate(path: string, action: () => void): void {
    const gatePath = path + '.gate';
    if (process.platform === 'win32') {
      withWindowsFileGate(gatePath, action);
      return;
    }
    this.withPortableFileGate(gatePath, action);
  }

  private withPortableFileGate(gatePath: string, action: () => void): void {
    const fd = this.openPortableGate(gatePath);
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid }));
      action();
    } finally {
      closeSync(fd);
      unlinkSync(gatePath);
    }
  }

  private openPortableGate(gatePath: string): number {
    try {
      return openSync(gatePath, 'wx');
    } catch {
      throw new Error(`Ownership operation busy or interrupted. Retry; if persistent, inspect ${gatePath} with all Job-Finish windows closed.`);
    }
  }

  private releaseAll(paths: string[], token: string): void {
    for (const path of paths) this.release(path, token);
  }

  // 잠금에 기록된 임의 토큰이 내 토큰과 같을 때만 소유권을 해제한다.
  private release(path: string, token: string): void {
    this.withOwnershipGate(path, this.releaseUnderGate.bind(this, path, token));
  }

  private releaseUnderGate(path: string, token: string): void {
    if (readOwnerRecord(path)?.token !== token) return;
    unlinkSync(path);
  }
}
/** 소유권 토큰을 검증하며 세션 체크포인트의 저장·복원과 임대 해제를 관리한다. */
export class Lease {
  private released = false;
  constructor(private paths: string[], private token: string, private releaseFn: () => void, private statePath: string) {}
  valid(): boolean {
    return !this.released && this.paths.every(path => readOwnerRecord(path)?.token === this.token);
  }
  load(): Checkpoint | undefined {
    if (!existsSync(this.statePath)) return;
    const state = JSON.parse(readFileSync(this.statePath, 'utf8')) as Checkpoint;
    if (state.version !== 1 || !Array.isArray(state.completed) || !Array.isArray(state.turns)) {
      throw new Error('Invalid session checkpoint');
    }
    return state;
  }
  save(state: Checkpoint): void {
    if (!this.valid()) throw new Error('Session ownership lost');
    const temporaryPath = this.statePath + '.' + this.token + '.tmp';
    writeFileSync(temporaryPath, JSON.stringify(state));
    renameSync(temporaryPath, this.statePath);
  }
  release(): void {
    if (this.released) return;
    this.releaseFn();
    this.released = true;
  }
}

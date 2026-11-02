// 프로세스 종료 시 회수되는 Windows 파일 핸들로 소유권 변경 작업을 직렬화한다.
import { toNamespacedPath } from 'node:path';

interface WindowsGateApi {
  open(...args: unknown[]): unknown;
  close(...args: unknown[]): unknown;
  error(): number;
}
let api: WindowsGateApi | undefined;
const GENERIC_READ_WRITE = 0xc0000000;
const OPEN_ALWAYS = 4;
const FILE_ATTRIBUTE_NORMAL = 0x80;
const FILE_FLAG_DELETE_ON_CLOSE = 0x04000000;

/** 프로세스가 종료돼도 Windows가 핸들과 gate 파일을 회수하는 배타 잠금 안에서 작업한다. */
export function withWindowsFileGate<T>(path: string, action: () => T): T {
  const native = getWindowsGateApi();
  // 공유를 금지한 핸들을 확보하고 닫을 때 gate 파일도 함께 회수한다.
  const flags = FILE_FLAG_DELETE_ON_CLOSE | FILE_ATTRIBUTE_NORMAL;
  const handle = native.open(toNamespacedPath(path), GENERIC_READ_WRITE, 0, null, OPEN_ALWAYS, flags, 0) as number | bigint;
  if (BigInt(handle) === -1n) throw new Error(`Ownership operation busy or unavailable (Win32 ${native.error()}): ${path}`);
  try {
    return action();
  } finally {
    native.close(handle);
  }
}

function getWindowsGateApi(): WindowsGateApi {
  if (api) return api;
  const koffi: typeof import('koffi', { with: { 'resolution-mode': 'import' } }) = require('koffi');
  const kernel = koffi.load('kernel32.dll');
  api = {
    open: kernel.func('__stdcall', 'CreateFileW', 'intptr_t', ['str16', 'uint32', 'uint32', 'void *', 'uint32', 'uint32', 'intptr_t']),
    close: kernel.func('__stdcall', 'CloseHandle', 'int32', ['intptr_t']),
    error: kernel.func('__stdcall', 'GetLastError', 'uint32', []),
  };
  return api;
}

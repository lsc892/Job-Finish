import { toNamespacedPath } from 'node:path';

let api: { open: (...args: unknown[]) => unknown; close: (...args: unknown[]) => unknown; error: () => number } | undefined;
/** Exclusive OS handle: Windows closes it and deletes the gate even if the host crashes. */
export function withWindowsFileGate<T>(path: string, action: () => T): T {
  if (!api) {
    const koffi: typeof import('koffi', { with: { 'resolution-mode': 'import' } }) = require('koffi');
    const kernel = koffi.load('kernel32.dll');
    api = {
      open: kernel.func('__stdcall', 'CreateFileW', 'intptr_t', ['str16', 'uint32', 'uint32', 'void *', 'uint32', 'uint32', 'intptr_t']),
      close: kernel.func('__stdcall', 'CloseHandle', 'int32', ['intptr_t']),
      error: kernel.func('__stdcall', 'GetLastError', 'uint32', []),
    };
  }
  // OPEN_ALWAYS + no sharing also handles abandoned gates left by older versions.
  // Null security attributes keep the handle out of child processes.
  const handle = api.open(toNamespacedPath(path), 0xc0000000, 0, null, 4, 0x04000080, 0) as number | bigint;
  if (BigInt(handle) === -1n) throw new Error(`Ownership operation busy or unavailable (Win32 ${api.error()}): ${path}`);
  try { return action(); } finally { api.close(handle); }
}

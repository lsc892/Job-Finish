import { withWindowsFileGate } from '../../src/windows/gate';
withWindowsFileGate(process.argv[2]!, () => {
  process.stdout.write('GATE_HELD\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
});

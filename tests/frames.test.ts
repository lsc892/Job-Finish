import test from 'node:test';
import assert from 'node:assert/strict';
import { Frames, FrameReduction } from '../src/runtime/frames';
import { LIMITS } from '../src/core/model';

function fixture(existing = false) {
  const values: unknown[] = []; const reductions: FrameReduction[] = [];
  const frames = new Frames(value => values.push(value), existing, reduction => reductions.push(reduction));
  return { frames, values, reductions };
}

test('Large JSON strings retain metadata after the body and leave later frames observable', () => {
  const f = fixture();
  const input = Buffer.from(JSON.stringify({ body: '한글😀\\\"\n'.repeat(180000), status: 'completed', id: 'turn' }) + '\n{"next":true}\n');
  for (let i = 0; i < input.length; i += 4093) {
    f.frames.push(input.subarray(i, i + 4093));
    assert.ok(f.frames.capacity <= LIMITS.messageBytes);
  }
  const result = f.values[0] as { body: string; status: string; id: string };
  assert.equal(result.status, 'completed'); assert.equal(result.id, 'turn');
  assert.ok(result.body.startsWith('한글😀\\\"\n'));
  assert.ok(!result.body.includes('�'));
  assert.ok(Buffer.byteLength(result.body) > LIMITS.textBytes);
  assert.ok(Buffer.byteLength(result.body) <= LIMITS.textBytes + 7);
  assert.deepEqual(f.values[1], { next: true });
  assert.deepEqual(f.reductions, [{ skipped: false, truncatedStrings: 1 }]);
});

test('Escapes and surrogate pairs at every string cutoff stay valid across byte chunks', () => {
  const limit = (LIMITS.textBytes + 4) * 6;
  for (const tail of ['\\uD83D\\uDE00', '\\n', '\\\\', '\\"', '한😀']) {
    for (let offset = 0; offset < 12; offset++) {
      const f = fixture();
      const input = Buffer.from('{"body":"' + 'x'.repeat(limit - offset) + tail.repeat(8) + '","id":"end"}\n');
      const boundary = Buffer.byteLength('{"body":"') + limit;
      f.frames.push(input.subarray(0, boundary - 3));
      for (const byte of input.subarray(boundary - 3)) f.frames.push(Buffer.from([byte]));
      const value = f.values[0] as { body: string; id: string };
      assert.equal(value.id, 'end');
      assert.ok(!value.body.includes('�'));
    }
  }
});

test('Oversized structure and keys skip only that frame, even with a split delimiter', () => {
  for (const frame of ['{"data":[' + '0,'.repeat(LIMITS.messageBytes) + '0]}', '{"' + 'k'.repeat(120000) + '":true}']) {
    const f = fixture();
    f.frames.push(Buffer.from(frame));
    assert.equal(f.values.length, 0);
    assert.ok(f.frames.capacity <= LIMITS.messageBytes);
    f.frames.push(Buffer.from('\r\n{"completed":true}\n'));
    assert.deepEqual(f.values, [{ completed: true }]);
    assert.equal(f.reductions[0]!.skipped, true);
  }
});

test('Discarded string tails still reject invalid escapes and UTF-8 instead of fabricating a completion', () => {
  for (const tail of [Buffer.from('\\q'), Buffer.from('\\uXYZ0'), Buffer.from([0xff])]) {
    const f = fixture();
    f.frames.push(Buffer.from('{"text":"' + 'x'.repeat(120000)));
    assert.throws(() => f.frames.push(Buffer.concat([tail, Buffer.from('","status":"completed"}\n')])));
    assert.equal(f.values.length, 0);
  }
});

test('Existing partial frames recover once and clear releases all parser state', () => {
  const f = fixture(true);
  f.frames.push(Buffer.from('\npartial}'));
  f.frames.push(Buffer.from('\n{"ok":true}\n'));
  assert.deepEqual(f.values, [{ ok: true }]);
  assert.throws(() => f.frames.push(Buffer.from('{bad}\n')));
  f.frames.push(Buffer.from('{"large":"' + 'x'.repeat(120000)));
  f.frames.clear(); assert.equal(f.frames.capacity, 0);
  f.frames.push(Buffer.from('{"afterClear":true}\n'));
  assert.deepEqual(f.values[1], { afterClear: true });
});

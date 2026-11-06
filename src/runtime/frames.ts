// 원본 스트림을 바꾸지 않고 JSONL 문자열의 보관량을 제한한다.
import { boundedText, LIMITS } from '../core/model';

export interface FrameReduction { skipped: boolean; truncatedStrings: number }
// JSON의 \uXXXX 표기에서도 결과 본문 16 KiB와 잘림 표시를 보관할 수 있다.
const STRING_BYTES = (LIMITS.textBytes + 4) * 6;

/** 긴 문자열은 앞부분만 해석하고, 구조 자체가 너무 큰 프레임은 다음 줄에서 재동기화한다. */
export class Frames {
  private buffer = Buffer.alloc(0);
  private length = 0;
  private first = true;
  private decoder = new TextDecoder('utf-8', { fatal: true });
  private invalid?: unknown;
  private skipped = false;
  private inString = false;
  private escaped = false;
  private unicodeLeft = 0;
  private stringStart = 0;
  private clipping = false;
  private clippedToken = false;
  private truncatedStrings = 0;

  constructor(private receive: (value: unknown) => void, private allowPartialStart: boolean,
    private reduced: (reduction: FrameReduction) => void) {}

  push(chunk: Buffer): void {
    let start = 0;
    for (let end; (end = chunk.indexOf(10, start)) >= 0;) {
      this.append(chunk.subarray(start, end));
      this.finish();
      start = end + 1;
    }
    this.append(chunk.subarray(start));
  }

  private append(chunk: Buffer): void {
    if (this.skipped || this.invalid || !chunk.length) return;
    try {
      // 버린 문자열 꼬리까지 UTF-8과 JSON escape를 검증한다.
      this.decoder.decode(chunk, { stream: true });
      for (const byte of chunk) {
        if (this.inString) {
          if (!this.escaped && !this.unicodeLeft && byte === 34) {
            if (this.clipping) this.compactString();
            this.inString = false;
            this.clippedToken = this.clipping;
            this.write(byte);
          } else {
            // escape 또는 UTF-8 문자 중간에서 보관을 멈추지 않는다.
            if (!this.clipping && !this.escaped && !this.unicodeLeft && (byte & 0xc0) !== 0x80
              && this.length - this.stringStart >= STRING_BYTES) this.clipping = true;
            if (byte < 32) throw new Error('Invalid control character in observed JSON string');
            if (this.unicodeLeft) {
              if (!(byte >= 48 && byte <= 57 || byte >= 65 && byte <= 70 || byte >= 97 && byte <= 102)) {
                throw new Error('Invalid Unicode escape in observed JSON string');
              }
              this.unicodeLeft--;
            } else if (this.escaped) {
              if (byte === 117) this.unicodeLeft = 4;
              else if (![34, 47, 92, 98, 102, 110, 114, 116].includes(byte)) throw new Error('Invalid observed JSON escape');
              this.escaped = false;
            } else if (byte === 92) this.escaped = true;
            if (!this.clipping) this.write(byte);
          }
        } else {
          // 큰 key를 잘라 다른 필드 이름으로 해석하지 않는다.
          if (byte === 58 && this.clippedToken) this.skipped = true;
          if (byte !== 32 && byte !== 9 && byte !== 13) this.clippedToken = false;
          this.write(byte);
          if (byte === 34) {
            this.inString = true;
            this.stringStart = this.length;
            this.clipping = false;
          }
        }
        if (this.skipped) { this.buffer = Buffer.alloc(0); this.length = 0; break; }
      }
    } catch (error) { this.invalid = error; }
  }

  private compactString(): void {
    const prefix = this.buffer.subarray(this.stringStart, this.length).toString('utf8');
    const text = (JSON.parse('"' + prefix + '"') as string).replace(/[\uD800-\uDBFF]$/, '');
    // Session의 기존 16 KiB 제한이 truncated를 기록할 수 있도록 조금 더 전달한다.
    const compact = Buffer.from(JSON.stringify(boundedText(text, LIMITS.textBytes + 4).text + '…').slice(1, -1));
    this.length = this.stringStart;
    for (const byte of compact) this.write(byte);
    this.truncatedStrings++;
  }

  private write(byte: number): void {
    if (this.skipped) return;
    if (this.length === LIMITS.messageBytes) { this.skipped = true; return; }
    if (this.length === this.buffer.length) {
      const next = Buffer.allocUnsafe(Math.min(LIMITS.messageBytes, Math.max(4096, this.length * 2)));
      this.buffer.copy(next, 0, 0, this.length);
      this.buffer = next;
    }
    this.buffer[this.length++] = byte;
  }

  private finish(): void {
    const skipped = this.skipped;
    const truncatedStrings = this.truncatedStrings;
    let value: unknown;
    let failure: unknown;
    try {
      if (!skipped) {
        if (this.invalid) throw this.invalid;
        this.decoder.decode();
        if (this.length) value = JSON.parse(this.buffer.subarray(0, this.length).toString('utf8'));
      }
    } catch (error) {
      if (!this.first || !this.allowPartialStart) failure = error;
    }
    if (this.length || skipped || this.invalid) this.first = false;
    this.reset();
    if (failure) throw failure;
    if (skipped || truncatedStrings) this.reduced({ skipped, truncatedStrings });
    if (value !== undefined) this.receive(value);
  }

  private reset(): void {
    this.length = 0;
    this.decoder = new TextDecoder('utf-8', { fatal: true });
    this.invalid = undefined;
    this.skipped = this.inString = this.escaped = this.clipping = this.clippedToken = false;
    this.unicodeLeft = this.truncatedStrings = 0;
  }

  clear(): void { this.reset(); this.buffer = Buffer.alloc(0); }
  get capacity(): number { return this.buffer.length; }
}

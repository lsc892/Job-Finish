import { open, stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

export class JsonlTail {
  private offset = 0;
  private remainder = "";
  private decoder = new StringDecoder("utf8");
  private inode?: number;
  private generation = 0;
  private sequence = 0;
  private discardPartialHistory = false;
  private queue: Promise<void> = Promise.resolve();
  constructor(readonly path: string, private onRecord: (record: unknown, position: string) => void,
    private onError: (error: unknown) => void) {}

  async initialize(fromStart = false): Promise<void> {
    const info = await stat(this.path);
    this.inode = info.ino;
    if (!fromStart) {
      this.offset = info.size;
      if (info.size) {
        const file = await open(this.path, "r");
        try {
          const last = Buffer.alloc(1);
          await file.read(last, 0, 1, info.size - 1);
          this.discardPartialHistory = last[0] !== 10;
        } finally { await file.close(); }
      }
    }
  }
  drain(): Promise<void> {
    this.queue = this.queue.then(() => this.read()).catch(this.onError);
    return this.queue;
  }
  private async read(): Promise<void> {
    let info;
    try { info = await stat(this.path); }
    catch (error: any) { if (error.code === "ENOENT") return; throw error; }
    if (info.ino !== this.inode || info.size < this.offset) {
      this.offset = 0; this.remainder = ""; this.decoder = new StringDecoder("utf8");
      this.discardPartialHistory = false; this.generation++; this.inode = info.ino;
    }
    if (info.size === this.offset) return;
    const file = await open(this.path, "r");
    try {
      // Bounded reads avoid allocating a whole transcript after a large append.
      while (this.offset < info.size) {
        const buffer = Buffer.alloc(Math.min(64 * 1024, info.size - this.offset));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, this.offset);
        if (!bytesRead) break;
        this.offset += bytesRead;
        this.remainder += this.decoder.write(buffer.subarray(0, bytesRead));
        let newline;
        while ((newline = this.remainder.indexOf("\n")) >= 0) {
          const line = this.remainder.slice(0, newline).trim();
          this.remainder = this.remainder.slice(newline + 1);
          const position = `${this.generation}:${++this.sequence}`;
          if (this.discardPartialHistory) { this.discardPartialHistory = false; continue; }
          if (!line) continue;
          try { this.onRecord(JSON.parse(line), position); } catch (error) { this.onError(error); }
        }
      }
    } finally { await file.close(); }
  }
}

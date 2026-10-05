import type { ThreadItem } from '../protocol/v2/ThreadItem';
import type { Turn } from '../protocol/v2/Turn';
import type { ThreadTurnsListParams } from '../protocol/v2/ThreadTurnsListParams';
import type { ThreadTurnsListResponse } from '../protocol/v2/ThreadTurnsListResponse';
import type { ThreadItemsListParams } from '../protocol/v2/ThreadItemsListParams';
import type { ThreadItemsListResponse } from '../protocol/v2/ThreadItemsListResponse';
import { LIMITS } from '../core/model';
import { StdioRpc } from './transport';

/** Bound every lookup independently of the total stored conversation size. */
export class CodexHistory {
  private pages = 0;
  constructor(private rpc: Pick<StdioRpc, 'request'>, private threadId: string, private check: () => void) {}
  assertCurrent(): void { this.check(); }
  private async page<T>(method: string, params: unknown): Promise<T> {
    this.check(); if (++this.pages > 64) throw new Error('Codex history lookup exceeds 64-page budget; unresolved state retained');
    const result = await this.rpc.request<T>(method, params); this.check(); return result;
  }
  private cursor(value: unknown, seen: Set<string>): string | undefined {
    if (value === null) return;
    if (typeof value !== 'string' || !value || seen.has(value)) throw new Error('Invalid or repeated Codex history cursor');
    seen.add(value); return value;
  }
  async turns(): Promise<{ turns: Turn[]; truncated: boolean }> {
    const turns: Turn[] = []; const seen = new Set<string>(); const ids = new Set<string>(); let cursor: string | undefined; let bytes = 0;
    do {
      const params: ThreadTurnsListParams = { threadId: this.threadId, limit: 32, sortDirection: 'desc', itemsView: 'notLoaded', cursor };
      const page = await this.page<ThreadTurnsListResponse>('thread/turns/list', params);
      if (!Array.isArray(page.data) || page.data.length > 32) throw new Error('Invalid Codex turn page');
      for (const turn of page.data) {
        if (typeof turn.id !== 'string' || !turn.id || ids.has(turn.id)) throw new Error('Invalid or repeated Codex history turn');
        ids.add(turn.id);
        const metadata = { ...turn, items: [] };
        bytes += Buffer.byteLength(JSON.stringify(metadata));
        if (bytes > LIMITS.queueBytes) throw new Error('Codex history metadata exceeds 4 MiB');
        turns.push(metadata);
      }
      cursor = this.cursor(page.nextCursor, seen);
    } while (cursor && turns.length < LIMITS.dedup);
    return { turns, truncated: !!cursor };
  }
  private async *items(turnId: string, direction: 'asc' | 'desc'): AsyncGenerator<ThreadItem> {
    let cursor: string | undefined; let count = 0; const seen = new Set<string>();
    do {
      const params: ThreadItemsListParams = { threadId: this.threadId, turnId, limit: 16, sortDirection: direction, cursor };
      const page = await this.page<ThreadItemsListResponse>('thread/items/list', params);
      if (!Array.isArray(page.data) || page.data.length > 16) throw new Error('Invalid Codex item page');
      for (const entry of page.data) {
        if (entry.turnId !== turnId || !entry.item || typeof entry.item !== 'object') throw new Error('Codex history item belongs to another turn');
        count++; yield entry.item;
      }
      cursor = this.cursor(page.nextCursor, seen);
    } while (cursor && count < LIMITS.dedup);
    if (cursor) throw new Error('Codex turn history exceeds 512-item lookup budget');
  }
  async matchesStart(turnId: string, requestId: string): Promise<boolean> {
    for await (const item of this.items(turnId, 'asc')) {
      if (item.type === 'userMessage' && item.clientId === requestId) return true;
    }
    return false;
  }
  async finalText(turnId: string): Promise<string | undefined> {
    for await (const item of this.items(turnId, 'desc')) {
      if (item.type === 'agentMessage' && item.phase !== 'commentary') {
        if (typeof item.text !== 'string') throw new Error('Invalid final response text');
        return item.text;
      }
    }
    return undefined;
  }
}

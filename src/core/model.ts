// 세션·알림의 공통 타입과 용량 상한·텍스트 제한·진단 기록을 정의한다.
export type Provider = 'codex' | 'claude';
export type Status = 'running' | 'completed' | 'error' | 'cancelled' | 'waitingForInput';
export type TerminalStatus = 'completed' | 'error' | 'cancelled';
export interface SessionBinding {
  windowInstanceId: string; provider: Provider; runtimeId: string;
  connectionId: string; sessionId: string;
}
export interface InputRequest {
  id: string; turnId: string; connectionId: string; title: string;
}
export interface TurnState { id: string; status: Status; text: string; truncated: boolean }
export interface Signal extends SessionBinding {
  notificationId: string; turnId: string; status: Status; text: string; truncated: boolean;
  sessionTitle?: string;
  requestId?: string; detail?: string; at: string;
  kind?: 'asyncQuestion';
}
export const LIMITS = { messageBytes: 1024 * 1024,
  results: 20, textBytes: 16 * 1024, diagnostics: 100, dedup: 512, turns: 32, requests: 128 } as const;
export function boundedText(text: string, limit = LIMITS.textBytes): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text);
  if (bytes.length <= limit) return { text, truncated: false };
  let end = limit;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(0, end).toString('utf8'), truncated: true };
}
// 표시 줄 수·아이콘·배율에 따른 실제 잘림은 Windows가 결정한다. 전송용 미리보기만 제한한다.
export function toastText(text: string): string {
  const preview = text.replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, ' ').trim();
  const chars = Array.from(preview);
  return chars.length > 1024 ? chars.slice(0, 1023).join('') + '…' : preview;
}
export function sessionTitleText(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return;
  const chars = Array.from(text);
  return chars.length > 100 ? chars.slice(0, 99).join('') + '…' : text;
}
export const isTerminal = (s: Status): s is TerminalStatus => s === 'completed' || s === 'error' || s === 'cancelled';

/** 용량을 제한한 진단 메시지·구조화 이벤트를 보관하고 기록 콜백에 전달한다. */
export class Diagnostics {
  readonly entries: { at: string; message: string }[] = [];
  readonly events: { at: string; event: string; [key: string]: unknown }[] = [];
  constructor(private log?: (entry: { at: string; event: string; [key: string]: unknown }) => void) {}
  trace(event: string, fields: Record<string, unknown> = {}): void {
    diagnostic: {
      const entry = { ...fields, at: new Date().toISOString(), event };
      this.events.push(entry);
      if (this.events.length > LIMITS.diagnostics) this.events.shift();
      this.log?.(entry);
    }
  }
  add(message: unknown, fields: Record<string, unknown> = {}): void {
    const text = boundedText(String(message), 2048).text;
    this.entries.push({ at: new Date().toISOString(), message: text });
    if (this.entries.length > LIMITS.diagnostics) this.entries.shift();
    diagnostic: this.trace('diagnostic.error', { ...fields, message: text,
      stack: message instanceof Error ? boundedText(message.stack ?? '', 4096).text : undefined });
  }
}

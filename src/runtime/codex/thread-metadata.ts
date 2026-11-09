// 단일·목록 메타데이터와 진단에서 같은 임시·하위 스레드 제외 조건을 사용한다.
import { record } from '../message';

export function isExcludedCodexThread(thread: Record<string, unknown>): boolean {
  const source = record(thread.source);
  return thread.ephemeral === true || !!(thread.parentThreadId || source?.subAgent);
}

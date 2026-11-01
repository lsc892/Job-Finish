// 관찰 메시지의 객체·식별자를 검증하고 중복 추적 컬렉션의 크기를 제한한다.
import { LIMITS } from '../core/model';

export const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
export const identifier = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : undefined;
export function bound(collection: Map<string, unknown> | Set<string>): void {
  while (collection.size > LIMITS.dedup) collection.delete(collection.keys().next().value!);
}

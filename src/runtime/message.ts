import { LIMITS } from '../core/model';

export const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
export const identifier = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : undefined;
export function bound(collection: Map<string, unknown> | Set<string>): void {
  while (collection.size > LIMITS.dedup) collection.delete(collection.keys().next().value!);
}

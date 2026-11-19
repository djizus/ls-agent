const LIMIT = 200_000;
const cache = new Map<string, unknown>();

export function cached<T>(key: string, compute: () => T): T {
  if (cache.has(key)) return cache.get(key) as T;
  if (cache.size >= LIMIT) cache.clear();
  const value = compute();
  cache.set(key, value);
  return value;
}

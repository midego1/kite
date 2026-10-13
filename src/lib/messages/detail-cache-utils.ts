// Each entry holds a full message body, and a long-lived tab can open thousands of messages.
export const MESSAGE_DETAIL_CACHE_LIMIT = 100;

/** Reads an entry and marks it most recently used (a Map iterates in insertion order). */
export function readRecent<K, V>(map: Map<K, V>, key: K): V | undefined {
	if (!map.has(key)) return undefined;
	const value = map.get(key) as V;
	map.delete(key);
	map.set(key, value);
	return value;
}

/** Stores an entry as most recently used and drops the least recently used beyond `limit`. */
export function rememberRecent<K, V>(map: Map<K, V>, key: K, value: V, limit: number): void {
	map.delete(key);
	map.set(key, value);
	while (map.size > Math.max(0, limit)) {
		const oldest = map.keys().next();
		if (oldest.done) break;
		map.delete(oldest.value);
	}
}

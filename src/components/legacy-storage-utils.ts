/**
 * Browsers that used the app before the rename to Kite keep their preferences,
 * sign-in state and per-user keys under `mailflare-*` and `mailflare:*`. This
 * runs first in <head>, before the other bootstrap scripts read their keys,
 * and moves every such entry to the same key with a `kite` prefix. A value
 * already stored under the new key wins, so running it again is harmless.
 */
export const legacyStorageMigrationScript = `(() => {
	for (const area of ["localStorage", "sessionStorage"]) {
		try {
			const storage = window[area];
			const legacy = [];
			for (let index = 0; index < storage.length; index += 1) {
				const key = storage.key(index);
				if (key && /^mailflare[-:]/.test(key)) legacy.push(key);
			}
			for (const key of legacy) {
				const next = "kite" + key.slice("mailflare".length);
				const value = storage.getItem(key);
				if (value !== null && storage.getItem(next) === null) storage.setItem(next, value);
				storage.removeItem(key);
			}
		} catch {}
	}
})();`;

/**
 * Listing helpers for the file bucket. Keys are listed in lexical (UTF-16 code unit) order, but the keys live
 * in a directory tree, so a walk can only stay in key order by sorting each directory's entries by the key
 * text they start. A directory `a` starts every key under it with `a/`, so it sorts as `a/`: `a.txt` sorts
 * before directory `a` (`.` is below `/`), exactly as the flat key list does.
 */
export function entrySortKey(name: string, isDirectory: boolean): string {
	return isDirectory ? `${name}/` : name;
}

/** Whether an entry (a file key, or a directory's key prefix ending in `/`) can hold a key in the page being listed. */
export function mayHoldKeys(path: string, isDirectory: boolean, prefix: string, after: string): boolean {
	if (isDirectory) {
		// Every key below starts with `path`: it must agree with the prefix either way round...
		if (!path.startsWith(prefix) && !prefix.startsWith(path)) return false;
		// ...and some key below must sort after `after`, which is so unless the whole subtree sorts before it.
		return !after || path > after || after.startsWith(path);
	}
	return path.startsWith(prefix) && (!after || path > after);
}

/** The later of the cursor and `startAfter`; list results begin strictly after it. */
export function listStart(cursor: string | undefined, startAfter: string | undefined): string {
	return [cursor, startAfter].reduce<string>((latest, key) => (key && key > latest ? key : latest), "");
}

export function listLimit(limit: number | undefined): number {
	return Math.min(Math.max(limit ?? 1000, 1), 1000);
}

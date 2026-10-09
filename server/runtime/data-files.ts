import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";

const DATABASE_FILE = "kite.sqlite";

/** Installs from before the Kite rename keep their database under this name. */
const LEGACY_DATABASE_FILE = "mailflare.sqlite";

const SQLITE_SIDE_FILES = ["-wal", "-shm", "-journal"];

/**
 * Path of the app database in the data directory. A database left under the
 * pre-rename file name is moved, with its WAL and journal files, before
 * SQLite opens it; the WAL must travel with the database or recent writes
 * are lost.
 */
export function adoptLegacyDatabaseFile(dataDir: string): string {
	const current = join(dataDir, DATABASE_FILE);
	const legacy = join(dataDir, LEGACY_DATABASE_FILE);
	if (existsSync(current) || !existsSync(legacy)) return current;
	for (const suffix of SQLITE_SIDE_FILES) {
		if (existsSync(legacy + suffix)) renameSync(legacy + suffix, current + suffix);
	}
	renameSync(legacy, current);
	return current;
}

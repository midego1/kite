import type { ObjectClass } from "./types";

const CLASS_PREFIXES: readonly [ObjectClass, readonly string[]][] = [
	["mail", ["inbound/", "imports/", "drafts/", "sent/", "attachments/", "jmap-uploads/", "bodies/"]],
	["drive", ["drive/"]],
	["backups", ["backups/"]],
];

/**
 * The class an object key belongs to, from its prefix. Anything unlisted (avatars, branding, alert state,
 * health checks) is `system`, which always stays on the default store so sign-in and branding never depend on an
 * external store.
 */
export function objectClassOf(key: string): ObjectClass {
	for (const [objectClass, prefixes] of CLASS_PREFIXES) {
		if (prefixes.some((prefix) => key.startsWith(prefix))) return objectClass;
	}
	return "system";
}

const DRIVE_KEY_PREFIX = "drive/";

/**
 * The Drive item id a `drive` class key names, or null for anything else: the inverse of `driveObjectKey`
 * (`src/lib/drive/name-utils.ts`), kept here instead of imported from it so storage code never reaches into a
 * module's own files for it.
 */
export function driveItemIdFromObjectKey(key: string): string | null {
	if (!key.startsWith(DRIVE_KEY_PREFIX)) return null;
	const id = key.slice(DRIVE_KEY_PREFIX.length);
	return id || null;
}

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

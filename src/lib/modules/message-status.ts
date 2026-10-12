import { notInArray } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { messages } from "@/db/schema";
import { messageStatusExclusions } from "./message-status-utils";
import { MODULE_MANIFESTS, moduleOwnedMessageStatuses } from "./registry";
import type { ModuleViewer } from "./state-types";
import { listEnabledModules } from "./state";

/**
 * The list condition that keeps module-owned statuses (composer templates) out of a message list: every owned
 * status is excluded, except the requested one while its module is on for the viewer. Asked for while the module
 * is off, the exclusion meets the caller's own status filter and the list is empty. Null when nothing is excluded.
 */
export async function ownedStatusCondition(
	env: Pick<CloudflareEnv, "DB">,
	viewer: ModuleViewer,
	requested: string | null,
): Promise<SQL | null> {
	const enabled =
		requested && moduleOwnedMessageStatuses().includes(requested) ? await listEnabledModules(env, viewer) : [];
	const excluded = messageStatusExclusions(MODULE_MANIFESTS, requested, enabled);
	return excluded.length > 0 ? notInArray(messages.status, excluded) : null;
}

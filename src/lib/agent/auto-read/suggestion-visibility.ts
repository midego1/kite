import type { SessionUser } from "@/lib/auth/types";
import { MODULE_CAPABILITIES } from "@/lib/modules/capability-registry";
import { listEnabledModules } from "@/lib/modules/state";
import { hiddenSuggestionKinds } from "./module-steps-utils";
import type { SuggestionKind } from "./suggestion-types";

/**
 * The suggestion kinds lists, counts, badges and cards must leave out for this user because the module
 * owning them is off. The rows stay stored, so turning the module back on shows them unchanged.
 */
export async function hiddenKindsFor(
	env: CloudflareEnv,
	user: Pick<SessionUser, "id" | "role" | "isPrimaryAdmin">,
): Promise<SuggestionKind[]> {
	const enabled = await listEnabledModules(env, {
		userId: user.id,
		role: user.role,
		isPrimaryAdmin: user.isPrimaryAdmin,
	});
	return hiddenSuggestionKinds(MODULE_CAPABILITIES, enabled) as SuggestionKind[];
}

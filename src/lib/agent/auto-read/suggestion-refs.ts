import { refTarget } from "@/lib/modules/record-ref-utils";
import type { RecordRefTarget } from "@/lib/modules/record-ref-types";
import { resolveRecordRefs } from "@/lib/modules/record-refs";
import type { SessionUser } from "@/lib/auth/types";

/**
 * Where each suggestion's message opens, resolved as `mail:message` refs in one batch. A message the viewer
 * cannot read, or one that is gone, comes back with no link, so a card never links to something that will not open.
 */
export async function messageTargets(
	env: CloudflareEnv,
	user: Pick<SessionUser, "id" | "role" | "isPrimaryAdmin">,
	messageIds: readonly string[],
): Promise<Map<string, RecordRefTarget>> {
	const ids = [...new Set(messageIds)];
	if (ids.length === 0) return new Map();
	const viewer = { userId: user.id, role: user.role, isPrimaryAdmin: user.isPrimaryAdmin };
	const resolved = await resolveRecordRefs(
		env,
		viewer,
		ids.map((id) => ({ kind: "mail:message", id })),
	);
	return new Map(resolved.map((answer) => [answer.id, refTarget(answer)]));
}

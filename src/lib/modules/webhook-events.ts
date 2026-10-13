import type { SessionUser } from "@/lib/auth/types";
import { listEnabledModules } from "./state";
import {
	WEBHOOK_EVENT_CATALOG,
	webhookEventOptions,
	webhookEventRefusal,
	type WebhookEventInfo,
} from "./webhook-events-utils";

type EventViewer = Pick<SessionUser, "id" | "role" | "isPrimaryAdmin">;

const viewerOf = (user: EventViewer) => ({ userId: user.id, role: user.role, isPrimaryAdmin: user.isPrimaryAdmin });

/** The events the viewer may subscribe to now; a disabled module's events are absent, and stored subscriptions keep theirs. */
export async function listWebhookEvents(
	env: CloudflareEnv,
	user: EventViewer,
): Promise<Pick<WebhookEventInfo, "value" | "label" | "hint">[]> {
	return webhookEventOptions(WEBHOOK_EVENT_CATALOG, await listEnabledModules(env, viewerOf(user)));
}

/** The 400 `MODULE_DISABLED` response for a webhook that newly asks for an event of a module that is off. */
export async function refuseDisabledWebhookEvents(
	env: CloudflareEnv,
	user: EventViewer,
	requested: readonly string[],
	existing: readonly string[] = [],
): Promise<Response | null> {
	if (requested.every((value) => existing.includes(value))) return null;
	const refusal = webhookEventRefusal(
		WEBHOOK_EVENT_CATALOG,
		await listEnabledModules(env, viewerOf(user)),
		requested,
		existing,
	);
	return refusal ? Response.json(refusal.body, { status: refusal.status }) : null;
}

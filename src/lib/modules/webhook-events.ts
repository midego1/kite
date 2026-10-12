import type { SessionUser } from "@/lib/auth/types";
import { listEnabledModules } from "./state";
import {
	availableWebhookEvents,
	WEBHOOK_EVENT_CATALOG,
	webhookEventRefusal,
	type WebhookEventInfo,
} from "./webhook-events-utils";

type EventViewer = Pick<SessionUser, "id" | "role" | "isPrimaryAdmin">;

const viewerOf = (user: EventViewer) => ({ userId: user.id, role: user.role, isPrimaryAdmin: user.isPrimaryAdmin });

/** Every event the registry knows, each marked with whether the viewer may subscribe to it now. */
export async function listWebhookEvents(
	env: CloudflareEnv,
	user: EventViewer,
): Promise<(Omit<WebhookEventInfo, "moduleId" | "moduleName"> & { available: boolean })[]> {
	const available = new Set(
		availableWebhookEvents(WEBHOOK_EVENT_CATALOG, await listEnabledModules(env, viewerOf(user))).map(
			(event) => event.value,
		),
	);
	return WEBHOOK_EVENT_CATALOG.map(({ value, label, hint }) => ({
		value,
		label,
		hint,
		available: available.has(value),
	}));
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

import type { ModuleId, ModuleManifest } from "./module-types";
import { MODULE_MANIFESTS } from "./registry";

/** One event a webhook can subscribe to. `moduleId` is `null` for the core message events. */
export type WebhookEventInfo = {
	value: string;
	label: string;
	hint: string;
	moduleId: ModuleId | null;
	moduleName: string | null;
};

/** The message events core has always emitted. @public Test-only: used inside this file, exported for tests. */
export const CORE_WEBHOOK_EVENTS: readonly WebhookEventInfo[] = [
	{
		value: "message.inbound",
		label: "Inbound message",
		hint: "A message was received and stored",
		moduleId: null,
		moduleName: null,
	},
	{
		value: "message.outbound",
		label: "Outbound message",
		hint: "A message was sent",
		moduleId: null,
		moduleName: null,
	},
	{
		value: "message.failed",
		label: "Delivery failure",
		hint: "An outbound message failed",
		moduleId: null,
		moduleName: null,
	},
];

/** Core events followed by every module's, whether the module is on or off. @public Test-only: `WEBHOOK_EVENT_CATALOG` below is the production value. */
export function webhookEventCatalog(
	manifests: readonly Pick<ModuleManifest, "id" | "name" | "webhookEvents">[],
): WebhookEventInfo[] {
	return [
		...CORE_WEBHOOK_EVENTS,
		...manifests.flatMap((manifest) =>
			manifest.webhookEvents.map((event) => ({ ...event, moduleId: manifest.id, moduleName: manifest.name })),
		),
	];
}

/** The one list every surface reads: validators, the picker, the API and the dispatcher. */
export const WEBHOOK_EVENT_CATALOG: readonly WebhookEventInfo[] = webhookEventCatalog(MODULE_MANIFESTS);

/** Every event value, for validators. Never empty because core always has events. */
export const WEBHOOK_EVENT_VALUES = WEBHOOK_EVENT_CATALOG.map((event) => event.value) as [string, ...string[]];

/** The module that owns an event, `null` for a core event and `undefined` for an event nobody declares. */
export function webhookEventOwner(catalog: readonly WebhookEventInfo[], value: string): ModuleId | null | undefined {
	return catalog.find((event) => event.value === value)?.moduleId;
}

/** Core events plus the events of modules in `enabled`. @public Test-only: `webhookEventOptions` is the production reader. */
export function availableWebhookEvents(
	catalog: readonly WebhookEventInfo[],
	enabled: Iterable<ModuleId>,
): WebhookEventInfo[] {
	const on = new Set(enabled);
	return catalog.filter((event) => event.moduleId === null || on.has(event.moduleId));
}

/** What the picker and the API list: the events of modules in `enabled`, without the owner. */
export function webhookEventOptions(
	catalog: readonly WebhookEventInfo[],
	enabled: Iterable<ModuleId>,
): Pick<WebhookEventInfo, "value" | "label" | "hint">[] {
	return availableWebhookEvents(catalog, enabled).map(({ value, label, hint }) => ({ value, label, hint }));
}

export type WebhookEventRefusal = {
	status: 400;
	body: { error: string; code: "MODULE_DISABLED"; moduleId: ModuleId };
};

/**
 * The 400 `MODULE_DISABLED` answer for adding an event of a module that is off. An event the webhook
 * already holds is never refused, so editing an unrelated field keeps a subscription whose module is off.
 */
export function webhookEventRefusal(
	catalog: readonly WebhookEventInfo[],
	enabled: Iterable<ModuleId>,
	requested: readonly string[],
	existing: readonly string[] = [],
): WebhookEventRefusal | null {
	const on = new Set(enabled);
	for (const value of requested) {
		const event = catalog.find((item) => item.value === value);
		if (!event?.moduleId || on.has(event.moduleId) || existing.includes(value)) continue;
		return {
			status: 400,
			body: {
				error: `${event.moduleName ?? event.moduleId} is turned off`,
				code: "MODULE_DISABLED",
				moduleId: event.moduleId,
			},
		};
	}
	return null;
}

/** The note left on a delivery that was dropped because its module is off, or `null` for a core event. */
export function moduleDisabledNote(catalog: readonly WebhookEventInfo[], value: string): string | null {
	const event = catalog.find((item) => item.value === value);
	return event?.moduleId ? `module_disabled: ${event.moduleName ?? event.moduleId} is turned off` : null;
}

import type { ModuleCapabilities } from "../module-types";
import { describeCapability, type DescriptorMeta } from "../schema-utils";
import { financeSchemas } from "./schemas";

const REMIND_TIMEOUT_MS = 30_000;

const describe = (name: string, meta: DescriptorMeta) => describeCapability(financeSchemas, name, meta);

const webhook = (name: string, value: string, description: string) =>
	describe(name, { surfaces: ["webhook_event"], description, effect: "none", event: { value } });

export const financeCapabilities: ModuleCapabilities = {
	moduleId: "finance",
	promptFragment: null,
	descriptors: [
		describe("resolveRefs", {
			surfaces: ["resolve_refs"],
			description: "Resolve subscription references to a link and a label.",
			scopes: ["finance.read"],
			effect: "read",
			refs: { kinds: ["finance:subscription"] },
		}),
		describe("remindRenewals", {
			surfaces: ["cron"],
			description: "Remind owners of tracked subscriptions that renew or end their trial soon.",
			scopes: ["finance.read", "finance.write"],
			effect: "update",
			timeoutMs: REMIND_TIMEOUT_MS,
			cron: { task: "remindRenewals" },
		}),
		webhook("subscriptionDetected", "finance.subscription.detected", "A subscription was added to Money Watch."),
		webhook("renewalDue", "finance.subscription.renewal_due", "A tracked subscription renews or its trial ends soon."),
	],
};

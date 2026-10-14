import { detectSubscriptionStep } from "@/lib/finance/detect";
import { resolveFinanceRefs } from "@/lib/finance/refs";
import { remindRenewals } from "@/lib/finance/reminders";
import type { CapabilityHandler } from "../module-types";

export const financeHandlers: Record<string, CapabilityHandler> = {
	detect: detectSubscriptionStep,
	resolveRefs: resolveFinanceRefs,
	remindRenewals,
};

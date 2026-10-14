import type { CapabilityHandler } from "@/lib/modules/module-types";

/** The renewal reminder cron task; it has nothing to remind about until subscriptions can be tracked. */
export const remindRenewals: CapabilityHandler = async () => ({ reminded: 0 });

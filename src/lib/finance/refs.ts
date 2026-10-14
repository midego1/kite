import { refsOf, refsOutput } from "@/lib/modules/handler-helpers";
import type { CapabilityHandler } from "@/lib/modules/module-types";

/** Every subscription ref reads as unavailable until tracked subscriptions can be resolved. */
export const resolveFinanceRefs: CapabilityHandler = async (input) => refsOutput(refsOf(input), new Map());

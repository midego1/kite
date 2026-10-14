import type { ModuleClient } from "../client-registry-types";
import { SubscriptionBlock } from "./subscription-block";

export const suggestionCards: NonNullable<ModuleClient["suggestionCards"]> = {
	subscription: { Block: SubscriptionBlock },
};

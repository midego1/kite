import { unavailableRefsHandler } from "../handler-helpers";
import type { CapabilityHandler } from "../module-types";

export const templatesHandlers: Record<string, CapabilityHandler> = {
	resolveRefs: unavailableRefsHandler,
};

import type { CapabilityHandler } from "../module-types";
import { resolveTemplateRefs } from "@/lib/templates/refs";

export const templatesHandlers: Record<string, CapabilityHandler> = {
	resolveRefs: resolveTemplateRefs,
};

import type { ModuleCapabilities } from "../module-types";
import { describeCapability } from "../schema-utils";
import { templatesSchemas } from "./schemas";

export const templatesCapabilities: ModuleCapabilities = {
	moduleId: "templates",
	promptFragment: null,
	descriptors: [
		describeCapability(templatesSchemas, "resolveRefs", {
			surfaces: ["resolve_refs"],
			description: "Resolve email template references to a label. Templates have no page, so the link is null.",
			scopes: ["templates.read"],
			effect: "read",
			refs: { kinds: ["templates:template"] },
		}),
	],
};

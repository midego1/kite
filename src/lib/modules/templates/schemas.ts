import type { ModuleSchemas } from "../schema-utils";
import { resolveRefsSchemas } from "../shared-schemas";

export const templatesSchemas: ModuleSchemas = {
	resolveRefs: resolveRefsSchemas(["templates:template"]),
};

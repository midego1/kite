import type { ModuleCapabilities } from "../module-types";
import { describeCapability } from "../schema-utils";
import { importSchemas } from "./schemas";

/**
 * One import run, kept just under the 15-minute wall-clock limit of a queue invocation: the platform ends it there
 * anyway, so an earlier timeout would only report an error while the run carried on. A run starts no new chunk after
 * its four-minute budget (`RUN_TIME_BUDGET_MS`), and one IMAP command may take up to ten minutes (`imapLimits`), which
 * together fit. The run's lease is renewed by its own heartbeat, so it does not bound this.
 */
const IMPORT_RUN_TIMEOUT_MS = 14 * 60_000;

const describe = (name: string, meta: Parameters<typeof describeCapability>[2]) =>
	describeCapability(importSchemas, name, meta);

export const importCapabilities: ModuleCapabilities = {
	moduleId: "import",
	promptFragment: null,
	descriptors: [
		describe("processImportJob", {
			surfaces: ["queue"],
			description: "Run one batch of a background IMAP import job.",
			scopes: ["import.run"],
			effect: "create",
			timeoutMs: IMPORT_RUN_TIMEOUT_MS,
			queue: { kind: "import.imap" },
		}),
		describe("resumeStalledImports", {
			surfaces: ["cron"],
			description: "Re-queue import jobs whose run stopped without handing off.",
			scopes: ["import.run"],
			effect: "update",
			timeoutMs: IMPORT_RUN_TIMEOUT_MS,
			cron: { task: "resumeStalledImports" },
		}),
		describe("resolveRefs", {
			surfaces: ["resolve_refs"],
			description: "Resolve import job references to a link and a label.",
			scopes: ["import.run"],
			effect: "read",
			refs: { kinds: ["import:job"] },
		}),
	],
};

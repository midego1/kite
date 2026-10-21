import type { ModuleCapabilities } from "../module-types";
import { describeCapability, type DescriptorMeta } from "../schema-utils";
import { driveSchemas } from "./schemas";

const PURGE_TIMEOUT_MS = 60_000;

const describe = (name: string, meta: DescriptorMeta) => describeCapability(driveSchemas, name, meta);

export const driveCapabilities: ModuleCapabilities = {
	moduleId: "drive",
	promptFragment: null,
	descriptors: [
		describe("resolveRefs", {
			surfaces: ["resolve_refs"],
			description: "Resolve Drive file and folder references to a link and a label.",
			scopes: ["drive.read"],
			effect: "read",
			refs: { kinds: ["drive:file"] },
		}),
		describe("purgeDrive", {
			surfaces: ["cron"],
			description:
				"Delete items that have been in the Drive trash longer than the retention, and abort uploads nobody finished.",
			effect: "delete",
			timeoutMs: PURGE_TIMEOUT_MS,
			cron: { task: "purgeDrive" },
		}),
		describe("storageListObjectKeys", {
			surfaces: ["storage_hook"],
			description: "List the stored Drive files on one object store, for a store migration.",
			effect: "read",
			storage: { objectClass: "drive", hook: "listObjectKeys" },
		}),
		describe("storageMarkMoved", {
			surfaces: ["storage_hook"],
			description: "Record that Drive files were copied to another object store.",
			effect: "update",
			storage: { objectClass: "drive", hook: "markMoved" },
		}),
		describe("storageCountOnStore", {
			surfaces: ["storage_hook"],
			description: "Count the Drive files that name an object store.",
			effect: "read",
			storage: { objectClass: "drive", hook: "countOnStore" },
		}),
		describe("storageUsage", {
			surfaces: ["storage_hook"],
			description: "Count the Drive files and bytes stored.",
			effect: "read",
			storage: { objectClass: "drive", hook: "usage" },
		}),
	],
};

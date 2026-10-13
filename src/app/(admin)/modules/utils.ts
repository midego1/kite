import { authFetch } from "@/lib/auth/client";
import type { ModuleAdminView } from "@/lib/modules/admin-types";
import type { ModuleId } from "@/lib/modules/module-types";

export const MODULES_QUERY_KEY = ["admin-modules"] as const;

async function readView(response: Response, fallback: string): Promise<ModuleAdminView> {
	const json = (await response.json().catch(() => ({}))) as Partial<ModuleAdminView> & { error?: string };
	if (!response.ok || !json.modules) throw new Error(json.error ?? fallback);
	return { migrationPending: !!json.migrationPending, modules: json.modules };
}

export async function fetchModuleAdminView(): Promise<ModuleAdminView> {
	return readView(await authFetch("/api/admin/modules"), "Failed to load modules");
}

export async function saveModuleEnabled(moduleId: ModuleId, enabled: boolean): Promise<ModuleAdminView> {
	const response = await authFetch("/api/admin/modules", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ moduleId, enabled }),
	});
	return readView(response, "Unable to change the module");
}

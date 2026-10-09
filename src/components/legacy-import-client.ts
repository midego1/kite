import type {
	LegacyImportMode,
	LegacyImportRun,
	LegacyImportStatus,
	LegacyRoutingResult,
	LegacyRoutingStatus,
} from "@/lib/legacy-import/types";

async function request<T>(path: string, init: RequestInit | undefined, fallback: string): Promise<T> {
	const response = await fetch(path, {
		cache: "no-store",
		...init,
		headers: init?.body ? { "Content-Type": "application/json" } : undefined,
	});
	const data = (await response.json().catch(() => ({}))) as T & { error?: string };
	if (!response.ok) throw new Error(data.error ?? fallback);
	return data;
}

export function fetchLegacyImportStatus(): Promise<LegacyImportStatus> {
	return request("/api/admin/legacy-import", undefined, "Could not read the old install");
}

export function startLegacyImportCopy(mode: LegacyImportMode): Promise<{ token: string; run: LegacyImportRun }> {
	return request(
		"/api/admin/legacy-import",
		{ method: "POST", body: JSON.stringify({ mode }) },
		"Could not start copying",
	);
}

export function runLegacyImportCopyStep(token: string, step: number): Promise<LegacyImportRun> {
	return request(
		"/api/admin/legacy-import/step",
		{ method: "POST", body: JSON.stringify({ token, step }) },
		"Copying failed",
	);
}

export function fetchLegacyRouting(): Promise<LegacyRoutingStatus> {
	return request("/api/admin/legacy-import/routing", undefined, "Could not read Email Routing");
}

export function moveLegacyRouting(): Promise<LegacyRoutingResult & { status: LegacyRoutingStatus }> {
	return request("/api/admin/legacy-import/routing", { method: "POST" }, "Could not update Email Routing");
}

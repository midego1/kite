import { authFetch } from "@/lib/auth/client";
import { CLIENT_MODULES } from "@/lib/modules/client-data";
import { formatUserDate } from "@/lib/time/utils";
import type { ActivityLog, ActivityMetadata } from "./types";

export async function fetchActivity(): Promise<ActivityLog[]> {
	const res = await authFetch("/api/activity");
	const json = (await res.json()) as { activities?: ActivityLog[]; error?: string };
	if (!res.ok) throw new Error(json.error ?? "Failed to load activity");
	return json.activities ?? [];
}

export function formatActivityDate(value: string): string {
	return formatUserDate(value, {
		dateStyle: "medium",
		timeStyle: "short",
	});
}

export function getActivityLabel(action: string): string {
	if (action === "auth.login") return "Login";
	if (action === "auth.logout") return "Logout";
	if (action === "module.enabled") return "Module on";
	if (action === "module.disabled") return "Module off";
	if (action === "module.user_access") return "Module access";
	if (action === "telemetry.enabled") return "Usage statistics on";
	if (action === "telemetry.disabled") return "Usage statistics off";
	return action;
}

export function isModuleActivity(action: string): boolean {
	return action.startsWith("module.");
}

/** One plain sentence for a module change, or null for any other activity. */
export function describeModuleActivity(log: ActivityLog, metadata: ActivityMetadata): string | null {
	if (!isModuleActivity(log.action)) return null;
	const name = CLIENT_MODULES.find((manifest) => manifest.id === metadata.moduleId)?.name ?? "a module";
	if (log.action === "module.enabled") return `Turned on ${name}`;
	if (log.action === "module.disabled") return `Turned off ${name}`;
	const user = log.targetEmail ?? "a user";
	return metadata.allowed ? `Allowed ${user} to use ${name}` : `Restricted ${user} from ${name}`;
}

export function getActivityMetadata(log: ActivityLog): ActivityMetadata {
	if (!log.metadata) return {};
	try {
		return JSON.parse(log.metadata) as ActivityMetadata;
	} catch {
		return {};
	}
}

import { authFetch } from "@/lib/auth/client";
import { CLIENT_MODULES } from "@/lib/modules/client-data";
import { formatUserDate } from "@/lib/time/utils";
import { UNSUBSCRIBE_ONE_CLICK_ACTION } from "@/lib/email/one-click-attempts-utils";
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
	if (action === "auth.passkey_added") return "Passkey added";
	if (action === "auth.passkey_removed") return "Passkey removed";
	if (action === "auth.mfa_reset") return "Two-factor reset";
	if (action === "module.enabled") return "Module on";
	if (action === "module.disabled") return "Module off";
	if (action === "module.user_access") return "Module access";
	if (action === "telemetry.enabled") return "Usage statistics on";
	if (action === "telemetry.disabled") return "Usage statistics off";
	if (action === "agent.provider_added") return "AI provider added";
	if (action === "agent.provider_updated") return "AI provider edited";
	if (action === "agent.provider_switched") return "AI provider switched";
	if (action === "agent.provider_deleted") return "AI provider deleted";
	if (action === UNSUBSCRIBE_ONE_CLICK_ACTION) return "One-click unsubscribe";
	return action;
}

const UNSUBSCRIBE_OUTCOMES: Record<string, string> = {
	done: "Sent; the sender confirmed",
	pending: "Sending",
	duplicate: "Not sent: already sent for this message a few minutes before",
	rate_limited: "Not sent: too many requests",
	refused_url: "Not sent: the link is not a public https address",
	timeout: "Sent; the sender did not answer in time",
	network: "Could not reach the sender",
	redirect: "Sent; the sender answered with a redirect",
	http_error: "Sent; the sender answered with an error",
};

/** One plain sentence for a one-click unsubscribe request, or null for any other activity. Never the link. */
export function describeUnsubscribeActivity(log: ActivityLog, metadata: ActivityMetadata): string | null {
	if (log.action !== UNSUBSCRIBE_ONE_CLICK_ACTION) return null;
	const outcome = UNSUBSCRIBE_OUTCOMES[metadata.outcome ?? "pending"] ?? "Sent";
	return typeof metadata.status === "number" && metadata.outcome !== "done"
		? `${outcome} (HTTP ${metadata.status})`
		: outcome;
}

/** Activities about something other than a sign-in, which have no device, place or IP address to show. */
export function isDevicelessActivity(action: string): boolean {
	return isModuleActivity(action) || action === UNSUBSCRIBE_ONE_CLICK_ACTION;
}

/** One plain sentence for a saved AI provider change, or null for any other activity. */
export function describeAgentProviderActivity(log: ActivityLog, metadata: ActivityMetadata): string | null {
	const name = metadata.name ?? "an AI provider";
	if (log.action === "agent.provider_added") return `Saved ${name}`;
	if (log.action === "agent.provider_deleted") return `Deleted ${name}`;
	if (log.action === "agent.provider_updated")
		return metadata.keyReplaced ? `Edited ${name} and replaced its API key` : `Edited ${name}`;
	if (log.action !== "agent.provider_switched") return null;
	return metadata.previous ? `Switched from ${metadata.previous} to ${name}` : `Switched to ${name}`;
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

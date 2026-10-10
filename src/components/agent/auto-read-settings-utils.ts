import { authFetch } from "@/lib/auth/client";
import type { AutonomyLevel } from "@/lib/agent/auto-read/settings-types";
import type { AgentSettings } from "./types";
import type {
	AutoReadAdminValues,
	AutoReadCapabilityKey,
	AutoReadForm,
	AutoReadSettingsResponse,
	AutoReadSettingsState,
	AutoReadUpdateBody,
} from "./auto-read-settings-types";

const MICROS_PER_DOLLAR = 1_000_000;
const PAUSE_MS = 24 * 60 * 60 * 1000;

export const AUTONOMY_OPTIONS: { value: AutonomyLevel; label: string; available: boolean }[] = [
	{ value: "off", label: "Off", available: true },
	{ value: "suggest", label: "Suggest only", available: true },
	{ value: "act", label: "Act with undo", available: false },
	{ value: "auto", label: "Full auto", available: false },
];

export const CAPABILITY_OPTIONS: { key: AutoReadCapabilityKey; label: string }[] = [
	{ key: "summary", label: "Summaries and tasks" },
	{ key: "reply", label: "Reply drafts" },
	{ key: "calendar", label: "Calendar invites" },
	{ key: "phishing", label: "Phishing warnings" },
];

export function microsToDollarInput(micros: number | null | undefined): string {
	if (micros === null || micros === undefined) return "";
	const dollars = micros / MICROS_PER_DOLLAR;
	return Number.isInteger(micros / 10_000) ? dollars.toFixed(2) : String(dollars);
}

/** Whole micro-dollars for a dollar amount; null for an empty input, undefined when it is not a valid amount. */
export function parseDollarInput(value: string): number | null | undefined {
	const trimmed = value.trim();
	if (!trimmed) return null;
	const dollars = Number(trimmed);
	if (!Number.isFinite(dollars) || dollars < 0) return undefined;
	return Math.round(dollars * MICROS_PER_DOLLAR);
}

/** Null when the response has no automatic reading fields (an older server or a mocked one). */
export function toAutoReadState(data: AutoReadSettingsResponse, now: number): AutoReadSettingsState | null {
	const { settings } = data;
	if (!settings.autonomy || !settings.capabilities) return null;
	const { calendar, reply, summary, phishing } = settings.capabilities;
	return {
		form: {
			autonomy: settings.autonomy,
			capabilities: { calendar, reply, summary, phishing },
			triageModelId: settings.triageModelId ?? "",
			dailyLimit: String(settings.autoReadDailyLimit ?? 200),
			spendCap: microsToDollarInput(settings.dailySpendCapMicros),
		},
		savedAutonomy: settings.autonomy,
		pausedUntil: activePauseEnd(settings.pausedUntil ?? null, now)?.toISOString() ?? null,
		models: data.models ?? [],
		canManage: data.canManage === true,
		autoReadAvailable: data.autoReadAvailable !== false,
		externalProviderBlocked: data.externalProviderBlocked === true,
		providerLabel: data.providerLabel || "the configured AI provider",
	};
}

/** The PUT body for the form, or an error message. Muted senders are left out because the server keeps them. */
export function autoReadUpdateBody(mailboxId: string, form: AutoReadForm): AutoReadUpdateBody | string {
	const limit = Number(form.dailyLimit);
	if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return "The daily triage limit must be between 1 and 1000";
	const cap = parseDollarInput(form.spendCap);
	if (cap === undefined) return "The spend cap must be empty or an amount of zero or more";
	return {
		mailboxId,
		autonomy: form.autonomy,
		capabilities: { ...form.capabilities },
		triageModelId: form.triageModelId || null,
		autoReadDailyLimit: limit,
		dailySpendCapMicros: cap,
	};
}

export function pauseEndFrom(now: number): string {
	return new Date(now + PAUSE_MS).toISOString();
}

/** The pause end while it is still in the future, otherwise null. */
function activePauseEnd(pausedUntil: string | null, now: number): Date | null {
	if (!pausedUntil) return null;
	const end = new Date(pausedUntil);
	return end.getTime() > now ? end : null;
}

/** Only the fields the legacy form edits, so saving it never overwrites automatic reading values it loaded earlier. */
export function legacyAgentSettingsBody(settings: AgentSettings): AgentSettings {
	const { mailboxId, enabled, modelId, autoDraftEnabled, reviewerUserId, instructions, dailyLimit } = settings;
	return { mailboxId, enabled, modelId, autoDraftEnabled, reviewerUserId, instructions, dailyLimit };
}

async function readJson<T extends { error?: string }>(response: Response, fallback: string): Promise<T> {
	const data = (await response.json().catch(() => ({}))) as T;
	if (!response.ok) throw new Error(data.error || fallback);
	return data;
}

export async function loadAutoReadSettings(mailboxId: string): Promise<AutoReadSettingsResponse> {
	const response = await authFetch(`/api/agent/settings?mailboxId=${encodeURIComponent(mailboxId)}`);
	return readJson<AutoReadSettingsResponse>(response, "Could not load automatic reading settings");
}

export async function saveAutoReadSettings(body: Partial<AutoReadUpdateBody> & { pausedUntil?: string | null }) {
	const response = await authFetch("/api/agent/settings", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	await readJson<{ error?: string }>(response, "Could not save automatic reading settings");
}

export async function loadAutoReadAdmin(): Promise<AutoReadAdminValues> {
	const data = await readJson<AutoReadAdminValues & { error?: string }>(
		await authFetch("/api/admin/agent"),
		"Could not load automatic reading settings",
	);
	return pickAutoReadAdmin(data);
}

/** Sends only install-wide automatic reading keys, which the admin route never parses as provider settings. */
export async function saveAutoReadAdmin(values: Partial<AutoReadAdminValues>): Promise<AutoReadAdminValues> {
	const response = await authFetch("/api/admin/agent", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(values),
	});
	return pickAutoReadAdmin(
		await readJson<AutoReadAdminValues & { error?: string }>(response, "Could not save automatic reading settings"),
	);
}

function pickAutoReadAdmin(data: AutoReadAdminValues): AutoReadAdminValues {
	return {
		autoReadEnabled: data.autoReadEnabled,
		externalAutoReadAllowed: data.externalAutoReadAllowed,
		dailySpendCapMicros: data.dailySpendCapMicros,
	};
}

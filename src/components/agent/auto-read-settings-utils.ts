import { authFetch } from "@/lib/auth/client";
import type { AutonomyLevel } from "@/lib/agent/auto-read/settings-types";
import type { SenderListName } from "@/lib/agent/auto-read/sender-lists-utils";
import { CLIENT_MODULES } from "@/lib/modules/client-data";
import type { ModuleId } from "@/lib/modules/module-types";
import type { AgentSettings } from "./types";
import { modelFallbackText } from "./model-fallback-utils";
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

export const SENDER_LIST_TEXT: Record<
	SenderListName,
	{ title: string; description: string; empty: string; inputLabel: string }
> = {
	trusted: {
		title: "Trusted senders",
		description:
			"Kite won't warn about a trusted sender because of the AI model alone, as long as their mail passes sender checks. Signs Kite finds itself still warn.",
		empty: 'No trusted senders yet. "Not phishing" on a phishing warning adds one.',
		inputLabel: "Add a trusted sender",
	},
	muted: {
		title: "Muted senders",
		description:
			"Kite doesn't send mail from a muted sender to the AI model and suggests nothing for it, except phishing warnings.",
		empty: 'No muted senders yet. "Don\'t suggest this for this sender" on a suggestion adds one.',
		inputLabel: "Add a muted sender",
	},
};

/** One switch per triage step of each module that is on, in registry order, from the modules' client data. */
export function moduleStepSwitches(enabled: readonly ModuleId[]): { key: string; label: string }[] {
	return CLIENT_MODULES.filter((module) => enabled.includes(module.id)).flatMap(
		(module) => module.triageSwitches ?? [],
	);
}

export function microsToDollarInput(micros: number | null | undefined): string {
	if (micros === null || micros === undefined) return "";
	const dollars = micros / MICROS_PER_DOLLAR;
	return Number.isInteger(micros / 10_000) ? dollars.toFixed(2) : String(dollars);
}

/** "Spent today: $0.37 of $2.00"; the spend is rounded up to the cent, so a nearly reached cap never reads as lower. */
export function spentTodayText(spentMicros: number, capMicros: number): string {
	const spent = (Math.ceil(Math.max(0, spentMicros) / 10_000) / 100).toFixed(2);
	return `Spent today: $${spent} of $${microsToDollarInput(capMicros)}`;
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
	const { calendar, reply, summary, phishing, modules } = settings.capabilities;
	return {
		form: {
			autonomy: settings.autonomy,
			capabilities: { calendar, reply, summary, phishing, modules: { ...modules } },
			triageModelId: settings.triageModelId ?? "",
			dailyLimit: String(settings.autoReadDailyLimit ?? 200),
			spendCap: microsToDollarInput(settings.dailySpendCapMicros),
		},
		savedAutonomy: settings.autonomy,
		pausedUntil: activePauseEnd(settings.pausedUntil ?? null, now)?.toISOString() ?? null,
		senders: {
			trusted: settings.capabilities.trustedSenders ?? [],
			muted: settings.capabilities.mutedSenders ?? [],
		},
		models: data.models ?? [],
		triageModelNotice: modelFallbackText(data.unavailableModels?.triage),
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
		capabilities: { ...form.capabilities, modules: { ...form.capabilities.modules } },
		triageModelId: form.triageModelId || null,
		autoReadDailyLimit: limit,
		dailySpendCapMicros: cap,
	};
}

/** Fired on window when a mailbox's automatic reading settings change outside the settings section. */
export const AGENT_SETTINGS_CHANGED_EVENT = "kite:agent-settings-changed";

export function dispatchAgentSettingsChanged(mailboxId: string): void {
	window.dispatchEvent(new CustomEvent(AGENT_SETTINGS_CHANGED_EVENT, { detail: { mailboxId } }));
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
	const { chatInstructions, draftInstructions, summaryInstructions } = settings;
	return {
		mailboxId,
		enabled,
		modelId,
		autoDraftEnabled,
		reviewerUserId,
		instructions,
		chatInstructions,
		draftInstructions,
		summaryInstructions,
		dailyLimit,
	};
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

/** Adds or removes one sender on its own, and returns the list as the server stored it. */
export async function saveSenderListEdit(
	mailboxId: string,
	list: SenderListName,
	change: "add" | "remove",
	sender: string,
): Promise<{ senders: string[]; changed: boolean }> {
	const response = await authFetch("/api/agent/settings/senders", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ mailboxId, list, [change]: sender }),
	});
	return readJson<{ senders: string[]; changed: boolean; error?: string }>(response, "Could not change the list");
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

/**
 * The spend cap input after a save: the saved value when that save sent the cap or the input still showed the
 * previous saved value, otherwise the unsaved text the admin typed.
 */
export function capInputAfterSave(
	input: string,
	previous: AutoReadAdminValues | null,
	update: Partial<AutoReadAdminValues>,
	saved: AutoReadAdminValues,
): string {
	const clean = !previous || input === microsToDollarInput(previous.dailySpendCapMicros);
	if ("dailySpendCapMicros" in update || clean) return microsToDollarInput(saved.dailySpendCapMicros);
	return input;
}

function pickAutoReadAdmin(data: AutoReadAdminValues): AutoReadAdminValues {
	return {
		autoReadEnabled: data.autoReadEnabled,
		externalAutoReadAllowed: data.externalAutoReadAllowed,
		dailySpendCapMicros: data.dailySpendCapMicros,
		autoReadTokenCap: data.autoReadTokenCap,
		chatTokenCap: data.chatTokenCap,
		tokenCapsReady: data.tokenCapsReady,
		spentTodayMicros: data.spentTodayMicros,
	};
}

/** A token allowance typed by the admin: a whole number from 1,000 to 1,000,000,000, or null. */
export function parseTokenAllowance(input: string): number | null {
	const value = Number(input.trim());
	return input.trim() && Number.isInteger(value) && value >= 1_000 && value <= 1_000_000_000 ? value : null;
}

import { z } from "zod";
import { GENERAL_INSTRUCTIONS_MAX_CHARS, TASK_INSTRUCTIONS_MAX_CHARS } from "../instruction-utils";
import { instructionText } from "../instruction-schema";
import type {
	AutoReadCapabilities,
	AutoReadInstallSettings,
	AutoReadProviderSummary,
	AutonomyLevel,
	MailboxAgentSettingsContext,
	MailboxAgentSettingsState,
	StoredMailboxAgentSettings,
} from "./settings-types";

const AUTONOMY_LEVELS = ["off", "suggest", "act", "auto"] as const;
const AVAILABLE_AUTONOMY_LEVELS: readonly AutonomyLevel[] = ["off", "suggest"];
const CAPABILITY_KEYS = ["calendar", "reply", "summary", "phishing"] as const;
const MAX_MUTED_SENDERS = 500;
const MODULE_SWITCH_KEY = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_MODULE_SWITCHES = 32;
const MAX_SPEND_CAP_MICROS = 1_000_000_000_000;

export const DEFAULT_INSTALL_SPEND_CAP_MICROS = 2_000_000;

export const mailboxAgentSettingsUpdateSchema = z.object({
	mailboxId: z.string().min(1),
	enabled: z.boolean().optional(),
	modelId: z.string().max(200).nullable().optional(),
	autoDraftEnabled: z.boolean().optional(),
	reviewerUserId: z.string().nullable().optional(),
	instructions: instructionText(GENERAL_INSTRUCTIONS_MAX_CHARS).optional(),
	chatInstructions: instructionText(TASK_INSTRUCTIONS_MAX_CHARS).optional(),
	draftInstructions: instructionText(TASK_INSTRUCTIONS_MAX_CHARS).optional(),
	summaryInstructions: instructionText(TASK_INSTRUCTIONS_MAX_CHARS).optional(),
	dailyLimit: z.number().int().min(1).max(100).optional(),
	autonomy: z.enum(AUTONOMY_LEVELS).optional(),
	capabilities: z
		.object({
			calendar: z.boolean().optional(),
			reply: z.boolean().optional(),
			summary: z.boolean().optional(),
			phishing: z.boolean().optional(),
			mutedSenders: z.array(z.string().trim().min(1).max(320)).max(MAX_MUTED_SENDERS).optional(),
			modules: z
				.record(z.string().regex(MODULE_SWITCH_KEY), z.boolean())
				.refine((value) => Object.keys(value).length <= MAX_MODULE_SWITCHES)
				.optional(),
		})
		.optional(),
	triageModelId: z.string().max(200).nullable().optional(),
	autoReadDailyLimit: z.number().int().min(1).max(1_000).optional(),
	dailySpendCapMicros: z.number().int().min(0).max(MAX_SPEND_CAP_MICROS).nullable().optional(),
	pausedUntil: z.iso.datetime({ offset: true }).nullable().optional(),
	listSummaries: z.boolean().optional(),
	listSummariesBulk: z.boolean().optional(),
	listSummaryDailyLimit: z.number().int().min(1).max(1_000).optional(),
});

type MailboxAgentSettingsUpdate = z.infer<typeof mailboxAgentSettingsUpdateSchema>;

const SETTINGS_ERRORS: Record<string, string> = {
	autonomy: "Choose a valid autonomy level",
	capabilities: "Invalid capabilities",
	triageModelId: "Choose a configured triage model",
	autoReadDailyLimit: "The daily automatic reading limit must be between 1 and 1000",
	dailySpendCapMicros: "The spend cap must be empty or zero or more",
	pausedUntil: "The pause end must be an ISO date",
	dailyLimit: "The daily draft limit must be between 1 and 100",
	instructions: "Instructions can be at most 4000 characters",
	chatInstructions: "Chat instructions can be at most 2000 characters",
	draftInstructions: "Drafting instructions can be at most 2000 characters",
	summaryInstructions: "Summary instructions can be at most 2000 characters",
	listSummaryDailyLimit: "The daily one-line summary limit must be between 1 and 1000",
};

/** The `mailbox_agent_settings` columns migration 0069 adds, by their keys in the settings state. */
export const TASK_INSTRUCTION_KEYS = ["chatInstructions", "draftInstructions", "summaryInstructions"] as const;

/** The `mailbox_agent_settings` columns migration 0072 adds, with the values that mean "nothing set". */
export const LIST_SUMMARY_DEFAULTS = { listSummaries: false, listSummariesBulk: false, listSummaryDailyLimit: 100 };

/** A short message naming the first invalid field of a settings update. */
export function describeSettingsError(error: z.ZodError): string {
	const field = error.issues[0]?.path[0];
	return (typeof field === "string" && SETTINGS_ERRORS[field]) || "Invalid settings";
}

/** Act with undo and Full auto exist in the schema but cannot be chosen yet. */
export function autonomyError(autonomy: AutonomyLevel | undefined): string | null {
	if (autonomy === undefined || AVAILABLE_AUTONOMY_LEVELS.includes(autonomy)) return null;
	return "This autonomy level is not available yet";
}

function defaultCapabilities(mailboxType: MailboxAgentSettingsContext["mailboxType"]): AutoReadCapabilities {
	return {
		calendar: mailboxType !== "shared",
		reply: true,
		summary: true,
		phishing: true,
		mutedSenders: [],
		trustedSenders: [],
		modules: {},
	};
}

function normalizeSenders(values: unknown[]): string[] {
	const senders = new Set<string>();
	for (const value of values) {
		if (typeof value !== "string") continue;
		const sender = value.trim().toLowerCase();
		if (sender) senders.add(sender);
	}
	return [...senders];
}

/** Only well-formed keys with boolean values survive, at most 32 of them. */
function normalizeModuleSwitches(value: unknown): Record<string, boolean> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const entries = Object.entries(value as Record<string, unknown>).filter(
		(entry): entry is [string, boolean] => MODULE_SWITCH_KEY.test(entry[0]) && typeof entry[1] === "boolean",
	);
	return Object.fromEntries(entries.slice(0, MAX_MODULE_SWITCHES));
}

function parseCapabilities(value: string | null, fallback: AutoReadCapabilities): AutoReadCapabilities {
	let parsed: unknown = null;
	try {
		parsed = value ? JSON.parse(value) : null;
	} catch {
		parsed = null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...fallback };
	const record = parsed as Record<string, unknown>;
	const capabilities = { ...fallback };
	for (const key of CAPABILITY_KEYS) if (typeof record[key] === "boolean") capabilities[key] = record[key];
	capabilities.mutedSenders = Array.isArray(record.mutedSenders) ? normalizeSenders(record.mutedSenders) : [];
	capabilities.trustedSenders = Array.isArray(record.trustedSenders) ? normalizeSenders(record.trustedSenders) : [];
	capabilities.modules = normalizeModuleSwitches(record.modules);
	return capabilities;
}

/**
 * Toggles replace stored values; muted senders are only ever added, so a stale settings form cannot unmute
 * anyone, and trusted senders are kept as stored.
 */
function mergeCapabilities(
	current: AutoReadCapabilities,
	input: MailboxAgentSettingsUpdate["capabilities"],
): AutoReadCapabilities {
	const merged = { ...current };
	for (const key of CAPABILITY_KEYS) merged[key] = input?.[key] ?? current[key];
	merged.mutedSenders = normalizeSenders([...current.mutedSenders, ...(input?.mutedSenders ?? [])]);
	merged.modules = normalizeModuleSwitches({ ...current.modules, ...input?.modules });
	return merged;
}

/** Muted senders are never evicted, so an update that would exceed the limit is refused as a whole. */
export function mutedSendersError(
	current: MailboxAgentSettingsState,
	input: MailboxAgentSettingsUpdate,
): string | null {
	if (!input.capabilities?.mutedSenders?.length) return null;
	const merged = mergeCapabilities(current.capabilities, input.capabilities).mutedSenders;
	return merged.length > MAX_MUTED_SENDERS ? `A mailbox can mute at most ${MAX_MUTED_SENDERS} senders` : null;
}

/**
 * Automatic reading only needs a reviewer who can read the mailbox; reply drafts check send permission when
 * they run. Send permission is demanded up front only when an update turns auto-drafting on or hands it to a
 * different reviewer, so pausing or stopping never depends on the reviewer's current access.
 */
export function requiredReviewerAccess(
	current: MailboxAgentSettingsState,
	next: MailboxAgentSettingsState,
	ownerUserId: string,
): "send" | "read" | null {
	const changed = (next.reviewerUserId || ownerUserId) !== (current.reviewerUserId || ownerUserId);
	if (next.autoDraftEnabled && (changed || !current.autoDraftEnabled)) return "send";
	return changed ? "read" : null;
}

function storedAutonomy(value: string): AutonomyLevel {
	return (AUTONOMY_LEVELS as readonly string[]).includes(value) ? (value as AutonomyLevel) : "off";
}

/** The effective settings of a mailbox, filling in defaults when it has never saved any. */
export function resolveMailboxAgentSettings(
	row: StoredMailboxAgentSettings | undefined,
	context: MailboxAgentSettingsContext,
): MailboxAgentSettingsState {
	const capabilities = defaultCapabilities(context.mailboxType);
	if (!row)
		return {
			mailboxId: context.mailboxId,
			modelId: null,
			autoDraftEnabled: false,
			reviewerUserId: context.ownerUserId,
			instructions: "",
			chatInstructions: "",
			draftInstructions: "",
			summaryInstructions: "",
			dailyLimit: 25,
			autonomy: "off",
			capabilities,
			triageModelId: null,
			autoReadDailyLimit: 200,
			dailySpendCapMicros: null,
			pausedUntil: null,
			...LIST_SUMMARY_DEFAULTS,
		};
	return {
		mailboxId: row.mailboxId,
		modelId: row.modelId,
		autoDraftEnabled: row.autoDraftEnabled,
		reviewerUserId: row.reviewerUserId,
		instructions: row.instructions,
		chatInstructions: row.chatInstructions ?? "",
		draftInstructions: row.draftInstructions ?? "",
		summaryInstructions: row.summaryInstructions ?? "",
		dailyLimit: row.dailyLimit,
		autonomy: storedAutonomy(row.autonomy),
		capabilities: parseCapabilities(row.capabilities, capabilities),
		triageModelId: row.triageModelId,
		autoReadDailyLimit: row.autoReadDailyLimit,
		dailySpendCapMicros: row.dailySpendCapMicros,
		pausedUntil: row.pausedUntil,
		listSummaries: row.listSummaries ?? LIST_SUMMARY_DEFAULTS.listSummaries,
		listSummariesBulk: row.listSummariesBulk ?? LIST_SUMMARY_DEFAULTS.listSummariesBulk,
		listSummaryDailyLimit: row.listSummaryDailyLimit ?? LIST_SUMMARY_DEFAULTS.listSummaryDailyLimit,
	};
}

function pick<T>(input: T | undefined, current: T): T {
	return input === undefined ? current : input;
}

function parsePausedUntil(input: string | null | undefined, current: Date | null): Date | null {
	if (input === undefined) return current;
	return input === null ? null : new Date(input);
}

/** Applies a partial update; fields the request leaves out keep their current value. */
export function applyMailboxAgentSettingsUpdate(
	current: MailboxAgentSettingsState,
	input: MailboxAgentSettingsUpdate,
): MailboxAgentSettingsState {
	return {
		mailboxId: current.mailboxId,
		modelId: pick(input.modelId, current.modelId),
		autoDraftEnabled: pick(input.autoDraftEnabled, current.autoDraftEnabled),
		reviewerUserId: pick(input.reviewerUserId, current.reviewerUserId),
		instructions: pick(input.instructions, current.instructions),
		chatInstructions: pick(input.chatInstructions, current.chatInstructions),
		draftInstructions: pick(input.draftInstructions, current.draftInstructions),
		summaryInstructions: pick(input.summaryInstructions, current.summaryInstructions),
		dailyLimit: pick(input.dailyLimit, current.dailyLimit),
		autonomy: pick(input.autonomy, current.autonomy),
		capabilities: mergeCapabilities(current.capabilities, input.capabilities),
		triageModelId: pick(input.triageModelId, current.triageModelId),
		autoReadDailyLimit: pick(input.autoReadDailyLimit, current.autoReadDailyLimit),
		dailySpendCapMicros: pick(input.dailySpendCapMicros, current.dailySpendCapMicros),
		pausedUntil: parsePausedUntil(input.pausedUntil, current.pausedUntil),
		listSummaries: pick(input.listSummaries, current.listSummaries),
		listSummariesBulk: pick(input.listSummariesBulk, current.listSummariesBulk),
		listSummaryDailyLimit: pick(input.listSummaryDailyLimit, current.listSummaryDailyLimit),
	};
}

export function configuredModelId(id: string | null, models: string[], fallback: string | null): string | null {
	return id && models.includes(id) ? id : fallback;
}

/** Rejects a requested chat or triage model the provider no longer lists. */
export function unknownModelError(input: MailboxAgentSettingsUpdate, models: string[]): string | null {
	if (input.modelId && !models.includes(input.modelId)) return "Choose a configured model";
	if (input.triageModelId && !models.includes(input.triageModelId)) return SETTINGS_ERRORS.triageModelId;
	return null;
}

const PRESET_LABELS: Record<AutoReadProviderSummary["preset"], string> = {
	haimaker: "Haimaker.ai",
	anthropic: "Anthropic",
	openai: "OpenAI",
	openrouter: "OpenRouter",
	groq: "Groq",
	custom: "a custom provider",
};

/** The name shown in "Message content is sent to …". */
function providerLabel(config: AutoReadProviderSummary): string {
	if (config.provider === "cloudflare") return "Workers AI";
	if (config.preset !== "custom") return PRESET_LABELS[config.preset];
	try {
		return new URL(config.baseUrl).hostname || PRESET_LABELS.custom;
	} catch {
		return PRESET_LABELS.custom;
	}
}

export function autoReadInstallFlags(install: AutoReadInstallSettings, provider: AutoReadProviderSummary) {
	return {
		autoReadAvailable: install.agentEnabled && install.autoReadEnabled,
		externalProviderBlocked: provider.provider === "compatible" && !install.externalAutoReadAllowed,
		providerLabel: providerLabel(provider),
	};
}

const AUTO_READ_ADMIN_KEYS = [
	"autoReadEnabled",
	"externalAutoReadAllowed",
	"dailySpendCapMicros",
	"autoReadTokenCap",
	"chatTokenCap",
];
/** A daily input-token allowance: at least 1,000 tokens, at most a billion. */
const tokenCap = z.number().int().min(1_000).max(1_000_000_000);

export const autoReadAdminSchema = z
	.object({
		autoReadEnabled: z.boolean().optional(),
		externalAutoReadAllowed: z.boolean().optional(),
		dailySpendCapMicros: z.number().int().min(0).max(MAX_SPEND_CAP_MICROS).optional(),
		autoReadTokenCap: tokenCap.optional(),
		chatTokenCap: tokenCap.optional(),
	})
	.strict();

/** True for a non-empty body whose keys are all install-wide automatic reading settings. */
export function isAutoReadAdminBody(body: unknown): boolean {
	if (!body || typeof body !== "object" || Array.isArray(body)) return false;
	const keys = Object.keys(body);
	return keys.length > 0 && keys.every((key) => AUTO_READ_ADMIN_KEYS.includes(key));
}

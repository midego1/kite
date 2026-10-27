export type AutonomyLevel = "off" | "suggest" | "act" | "auto";

export type AutoReadCapabilities = {
	calendar: boolean;
	reply: boolean;
	summary: boolean;
	phishing: boolean;
	/** Lowercased sender addresses the user muted from a suggestion card or the settings list. */
	mutedSenders: string[];
	/**
	 * Lowercased sender addresses the user marked "Not phishing" or added in the settings list: a model's
	 * flag alone no longer warns about them. Only that button, its undo and the list's add and remove
	 * (`/api/agent/settings/senders`) change it; settings saves keep it as stored.
	 */
	trustedSenders: string[];
	/** Module step switches by their `triage.capability` key; a key that is absent is on. */
	modules: Record<string, boolean>;
};

export type MailboxAgentSettingsState = {
	mailboxId: string;
	modelId: string | null;
	autoDraftEnabled: boolean;
	reviewerUserId: string | null;
	instructions: string;
	/** Task-specific preferences (migration 0069); they read as empty before it is applied. */
	chatInstructions: string;
	draftInstructions: string;
	summaryInstructions: string;
	dailyLimit: number;
	autonomy: AutonomyLevel;
	capabilities: AutoReadCapabilities;
	triageModelId: string | null;
	autoReadDailyLimit: number;
	dailySpendCapMicros: number | null;
	pausedUntil: Date | null;
	/** One-line summaries in the message list (migration 0072); off before it is applied. */
	listSummaries: boolean;
	/** Whether newsletters, notifications and other bulk or automatic mail get a line too. */
	listSummariesBulk: boolean;
	listSummaryDailyLimit: number;
};

/** A stored `mailbox_agent_settings` row, as far as these helpers read it. */
export type StoredMailboxAgentSettings = Omit<MailboxAgentSettingsState, "capabilities" | "autonomy"> & {
	autonomy: string;
	capabilities: string | null;
};

export type MailboxAgentSettingsContext = {
	mailboxId: string;
	ownerUserId: string;
	mailboxType: "personal" | "shared";
};

export type AutoReadInstallSettings = {
	agentEnabled: boolean;
	autoReadEnabled: boolean;
	externalAutoReadAllowed: boolean;
	dailySpendCapMicros: number;
	/** Daily input tokens without model rates (migration 0069; the default before it). */
	autoReadTokenCap: number;
	chatTokenCap: number;
};

export type AutoReadProviderSummary = {
	provider: "cloudflare" | "compatible";
	preset: "haimaker" | "anthropic" | "openai" | "openrouter" | "groq" | "custom";
	baseUrl: string;
};

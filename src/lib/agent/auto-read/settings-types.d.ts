export type AutonomyLevel = "off" | "suggest" | "act" | "auto";

export type AutoReadCapabilities = {
	calendar: boolean;
	reply: boolean;
	summary: boolean;
	phishing: boolean;
	/** Lowercased sender addresses the user muted from a suggestion card. */
	mutedSenders: string[];
	/**
	 * Lowercased sender addresses the user marked "Not phishing": a model's flag alone no longer warns
	 * about them. Only that button and its undo change the list; settings saves keep it as stored.
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
	dailyLimit: number;
	autonomy: AutonomyLevel;
	capabilities: AutoReadCapabilities;
	triageModelId: string | null;
	autoReadDailyLimit: number;
	dailySpendCapMicros: number | null;
	pausedUntil: Date | null;
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
};

export type AutoReadProviderSummary = {
	provider: "cloudflare" | "compatible";
	preset: "haimaker" | "anthropic" | "openai" | "openrouter" | "groq" | "custom";
	baseUrl: string;
};

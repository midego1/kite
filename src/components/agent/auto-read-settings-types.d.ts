import type { AutoReadCapabilities, AutonomyLevel } from "@/lib/agent/auto-read/settings-types";

export type AutoReadCapabilityKey = Exclude<keyof AutoReadCapabilities, "mutedSenders">;
export type AutoReadCapabilityToggles = Record<AutoReadCapabilityKey, boolean>;

export type AutoReadSettingsResponse = {
	settings: {
		mailboxId: string;
		autonomy?: AutonomyLevel;
		capabilities?: AutoReadCapabilities;
		triageModelId?: string | null;
		autoReadDailyLimit?: number;
		dailySpendCapMicros?: number | null;
		pausedUntil?: string | null;
	};
	models?: string[];
	canManage?: boolean;
	autoReadAvailable?: boolean;
	externalProviderBlocked?: boolean;
	providerLabel?: string;
	error?: string;
};

/** Editable values as the inputs hold them; numbers stay strings until they are saved. */
export type AutoReadForm = {
	autonomy: AutonomyLevel;
	capabilities: AutoReadCapabilityToggles;
	triageModelId: string;
	dailyLimit: string;
	spendCap: string;
};

export type AutoReadSettingsState = {
	form: AutoReadForm;
	savedAutonomy: AutonomyLevel;
	/** The pause end while it was still in the future when the settings loaded. */
	pausedUntil: string | null;
	models: string[];
	canManage: boolean;
	autoReadAvailable: boolean;
	externalProviderBlocked: boolean;
	providerLabel: string;
};

export type AutoReadUpdateBody = {
	mailboxId: string;
	autonomy: AutonomyLevel;
	capabilities: AutoReadCapabilityToggles;
	triageModelId: string | null;
	autoReadDailyLimit: number;
	dailySpendCapMicros: number | null;
};

export type AutoReadAdminValues = {
	autoReadEnabled: boolean;
	externalAutoReadAllowed: boolean;
	dailySpendCapMicros: number;
};

export type AutoReadSettingsProps = { mailboxId: string };
export type AutoReadStatus = { tone: "error" | "ok"; text: string } | null;

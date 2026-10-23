import type { AutoReadCapabilities, AutonomyLevel } from "@/lib/agent/auto-read/settings-types";
import type { SenderListName } from "@/lib/agent/auto-read/sender-lists-utils";

export type AutoReadCapabilityKey = Exclude<keyof AutoReadCapabilities, "mutedSenders" | "trustedSenders" | "modules">;
/** The core switches, plus each module step's switch by its key (absent means on). */
export type AutoReadCapabilityToggles = Record<AutoReadCapabilityKey, boolean> & { modules: Record<string, boolean> };

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
	/** Saved on their own by each add or remove, so they are not part of the form. */
	senders: SenderLists;
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

export type SenderLists = Record<SenderListName, string[]>;

export type SenderListsProps = {
	mailboxId: string;
	senders: SenderLists;
	disabled: boolean;
	onChange: (senders: SenderLists) => void;
};

export type SenderListEditorProps = {
	mailboxId: string;
	list: SenderListName;
	senders: string[];
	disabled: boolean;
	onChange: (senders: string[]) => void;
};
export type AutoReadStatus = { tone: "error" | "ok"; text: string } | null;

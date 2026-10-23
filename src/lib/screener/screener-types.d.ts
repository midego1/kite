export type ScreenerMode = "screener" | "inbox";

export type ScreenerDecision = "approved" | "denied";

export type ScreenerDecisionSource = "manual" | "sent";

/** A mailbox's Screener switch; `null` from the readers means off (no row, or migration 0067 not applied). */
export type ScreenerSettings = {
	enabled: boolean;
	mode: ScreenerMode;
};

/**
 * What delivery does with one inbound message: `deliver` as usual, `hold` it in the Screener, `mark` it as
 * a new sender in the Inbox, or file it as `spam` because the sender was denied.
 */
export type ScreenerVerdict = "deliver" | "hold" | "mark" | "spam";

export type ScreenerSenderEntry = {
	address: string;
	decision: ScreenerDecision;
	source: ScreenerDecisionSource;
	createdAt: string;
};

export type ScreenerSettingsPatch = {
	enabled?: boolean;
	mode?: ScreenerMode;
};

export type ScreenerSenderRequest = {
	mailboxId: string;
	address: string;
	decision: ScreenerDecision;
};

export type ScreenerSenderRemoval = {
	mailboxId: string;
	address: string;
	/** Undo of an approval: messages it released go back to the Screener. */
	restoreMessageIds: string[];
};

export type ScreenerOverview = {
	/** False until migration 0067 is applied. */
	available: boolean;
	canManage: boolean;
	settings: ScreenerSettings;
	approved: ScreenerSenderEntry[];
	denied: ScreenerSenderEntry[];
	waiting: number;
};

export type ScreenerDecisionResult = {
	address: string;
	decision: ScreenerDecision;
	/** Messages moved: back to the Inbox or a folder on approve, to Spam on deny. */
	movedMessageIds: string[];
	blocked: boolean;
};

/** What the reader needs to offer Approve / Deny for one message. */
export type ScreenerMessageStatus = {
	pending: boolean;
	address: string | null;
	mailboxId: string | null;
	mode: ScreenerMode | null;
	canManage: boolean;
};

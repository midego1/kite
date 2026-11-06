/** What a connected account mirrors between Kite and the provider (spec §6.8); everything is off by default. */
export type TwoWaySettings = {
	kiteDelete: "nothing" | "trash";
	kiteArchive: "nothing" | "archive";
	kiteSpam: "nothing" | "spam";
	kiteFlags: boolean;
	providerGone: "nothing" | "trash";
	providerFlags: boolean;
};

/** A move Kite can make at the provider. */
export type ProviderMoveKind = "trash" | "archive" | "spam";

/** What the account's server can do, from its capabilities and `LIST`. */
export type ProviderSupport = {
	/** `move` is `UID MOVE`, `copy` the UIDPLUS fallback, null means the server cannot move a message safely. */
	moveMethod: "move" | "copy" | null;
	trashFolder: string | null;
	junkFolder: string | null;
	/** `\Archive`, or on Gmail `\All` (a move there takes the Inbox label off). */
	archiveFolder: string | null;
	gmail: boolean;
	checkedAt: string;
};

/** The answer of `GET /api/external-accounts/[id]/two-way`. */
export type TwoWayView = {
	settings: TwoWaySettings;
	/** Null when Kite could not ask the server. */
	support: ProviderSupport | null;
	/** Changes still waiting to reach the provider. */
	pending: number;
	/** The account's latest problems, newest first. */
	problems: { at: string; message: string }[];
	/** How many of the newest Inbox messages are compared with the provider. */
	windowSize: number;
};

/** What a user just did to messages in Kite. `other` is any other move: it only cancels a waiting move. */
export type KiteChange = { kind: ProviderMoveKind | "other" } | { kind: "flags"; read?: boolean; starred?: boolean };

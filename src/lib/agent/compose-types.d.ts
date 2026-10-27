import type { PersonalInstructions } from "./instruction-types";

export type ComposeMode = "write" | "rewrite";

export type ComposeAction = "shorter" | "longer" | "formal" | "casual" | "grammar" | "translate" | "custom";

/** The email being replied to, loaded by the server from the mailbox; never the client's copy of the quote. */
export type ComposeSource = {
	id: string;
	from: string;
	subject: string;
	date: Date;
	body: string;
};

export type ComposePromptInput = {
	mode: ComposeMode;
	action?: ComposeAction;
	/** The write request or the custom instruction, in the user's own words. */
	instruction?: string;
	/** The target language of a translation. */
	language?: string;
	/** The selection or body to rewrite, as plain text. */
	text?: string;
	subject?: string;
	/** Display names of the recipients, used only for the greeting. */
	recipientNames: string[];
	source: ComposeSource | null;
	userName: string;
	mailboxAddress: string;
	instructions: { general: string; draft: string };
	personal: PersonalInstructions | null;
	nonce?: string;
};

export type ComposePrompt = { system: string; messages: { role: "user"; content: string }[] };

/** A warning the panel shows next to a finished text. */
export type ComposeWarning = "removed_address" | "removed_link" | "link_from_email" | "truncated";

export type ComposeOutcome = { ok: true; text: string; warnings: ComposeWarning[] } | { ok: false; error: string };

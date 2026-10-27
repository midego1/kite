/** One set of instruction fields: the general one and one per task. */
export type InstructionSet = {
	general: string;
	chat: string;
	draft: string;
	summary: string;
};

export type InstructionTask = "chat" | "draft" | "summary";

/** A user's own instructions, with the name their heading uses. */
export type PersonalInstructions = InstructionSet & { name: string };

/** What the chat prompt adds after the mailbox's general instructions; every field may be empty. */
export type ChatPreferences = {
	mailbox: Pick<InstructionSet, "chat" | "draft">;
	personal: PersonalInstructions | null;
};

/** What a reply draft prompt adds after the mailbox's general instructions; every field may be empty. */
export type DraftPreferences = {
	mailboxDraft: string;
	personal: PersonalInstructions | null;
};

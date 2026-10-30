import type { contacts } from "@/db/schema";
import type { ContactSource } from "@/lib/email/address-types";

export type ContactRow = typeof contacts.$inferSelect;

export type ContactInput = {
	userId: string;
	address: string;
	source: ContactSource;
	/** False skips the Gravatar lookup, which tells a third party that this address mailed us. */
	lookupAvatar?: boolean;
};

export type BlockContactInput = {
	userId: string;
	mailboxId: string;
	domainId: string;
	address: string;
};

/** A contact's saved name and where it came from: only a `manual` name was chosen by the user. */
export type ContactDisplayName = {
	displayName: string;
	source: ContactSource;
};

export type MessageContactNames = {
	/** The sender label: a name the user gave the contact, else this message's From name, else a learned name. */
	fromContactName: string | null;
	toContactName: string | null;
};

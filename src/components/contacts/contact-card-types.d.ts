import type { ReactNode } from "react";
import type { ContactDetailsRecord } from "./contact-details-types";

export type ContactCardProps = {
	mailboxId: string | null;
	/** The person's address; a header form (Name <mailbox>) works too. */
	address: string;
	name: string;
	/** Addresses of the mailbox itself. A match shows "You" and leaves out the actions about someone else. */
	ownAddresses: readonly string[];
	/** The address mail from the card goes out from. */
	ownAddress: string;
	/** Other addresses the same person used, for the hover tooltip. */
	otherAddresses?: readonly string[];
	/** Hover and focus tooltip with the full address. Off where the address already sits beside the name. */
	tooltip?: boolean;
	triggerClassName?: string;
	/** The face of the trigger button. */
	children: ReactNode;
};

export type ContactCardHeaderProps = {
	mailboxId: string | null;
	email: string;
	displayName: string;
	own: boolean;
	contact: ContactDetailsRecord | null;
	/** Blocked from this card or by the saved contact, even when the contact failed to load. */
	blocked: boolean;
	otherAddresses?: readonly string[];
	copied: boolean;
	onCopy: () => void;
};

export type ContactCardActionsProps = {
	email: string;
	displayName: string;
	/** The user may change contacts of this mailbox (Edit contact, Block contact). */
	canEdit: boolean;
	/** The permission on the mailbox allows sending (not read-only), so New email would not be refused. */
	canSend: boolean;
	isContact: boolean;
	blocked: boolean;
	confirmBlock: boolean;
	busy: boolean;
	onNewEmail: () => void;
	onShowMail: () => void;
	onEdit: () => void;
	onBlock: () => void;
};

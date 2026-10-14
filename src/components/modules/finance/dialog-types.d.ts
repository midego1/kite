import type { DocumentDraft, ManualDraft } from "@/lib/finance/manual-utils";

export type DraftAttachment = { id: string; filename: string; contentType: string; size: number };

/** What `POST /api/finance/detect` answers for one message. */
export type DetectAnswer = {
	messageId: string;
	mailboxId: string;
	draft: ManualDraft;
	attachments: DraftAttachment[];
};

export type DocumentType = DocumentDraft["docType"];

/** The editable document fields, as text the inputs hold. */
export type DocumentForm = {
	docType: DocumentType;
	amount: string;
	currency: string;
	documentOn: string;
	periodStartOn: string;
	periodEndOn: string;
	attachmentId: string;
};

/** The editable subscription fields of "Track as subscription", as text the inputs hold. */
export type TrackForm = {
	vendor: string;
	plan: string;
	amount: string;
	currency: string;
	cycle: string;
	nextRenewalOn: string;
	trialEndsOn: string;
	reminderDays: string;
	calendarReminder: boolean;
};

/** A tracked subscription as the document dialog lists it. */
export type TrackedOption = { id: string; vendor: string; plan: string | null; status: string };

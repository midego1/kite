import type { CancelLink } from "./cancel-link-utils";
import type { DocumentInfo, StepAttachment } from "./document-utils";

export type Cycle = "weekly" | "monthly" | "quarterly" | "yearly";

export type SubscriptionEvent = "new" | "renewal" | "price_change" | "trial" | "payment_failed" | "refund";

/** The triage-step input the `detect` step reads (the wide step input of the module platform). */
export type DetectStepInput = {
	message: {
		id: string;
		mailboxId: string;
		from: string;
		fromName: string | null;
		subject: string | null;
		receivedAt: string;
		textExcerpt: string | null;
	};
	facts: {
		authPassed: boolean;
		bulk: boolean;
		knownContact: boolean;
		phishing: string[];
		automatic: boolean;
		noReply: boolean;
		list: boolean;
		spam: boolean;
	};
	headers: { listUnsubscribe: string | null; listUnsubscribePost: string | null; listId: string | null };
	attachments: StepAttachment[];
	model: Record<string, unknown> | null;
};

/** The columns of a tracked subscription the detector matches against. */
export type TrackedMatchRow = {
	id: string;
	vendorKey: string;
	plan: string | null;
	amountMinor: number | null;
	currency: string | null;
	cycle: Cycle | null;
};

export type ModelField =
	"vendor" | "plan" | "amount" | "currency" | "cycle" | "nextRenewalOn" | "trialEndsOn" | "docType";

/** The `subscription` suggestion payload (spec §5.8). */
export type SubscriptionPayload = {
	event: SubscriptionEvent;
	subscriptionId: string | null;
	vendor: string;
	vendorKey: string;
	plan: string | null;
	amountMinor: number | null;
	currency: string | null;
	previousAmountMinor: number | null;
	cycle: Cycle | null;
	nextRenewalOn: string | null;
	renewalEstimated: boolean;
	trialEndsOn: string | null;
	cancelLink: CancelLink | null;
	document: DocumentInfo | null;
	unverified: boolean;
	signals: string[];
	modelFields: ModelField[];
	modelDisagrees: ("amount" | "currency")[];
};

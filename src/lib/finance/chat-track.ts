import { moduleHost } from "@/lib/modules/host";
import type { HostMessageDetail } from "@/lib/modules/host-types";
import type { CapabilityCallContext, CapabilityHandler, JsonValue } from "@/lib/modules/module-types";
import { chatTrackInputSchema, type ChatTrackInput } from "./chat-track-schema";
import {
	attachRequestBody,
	findExisting,
	mergeProposal,
	proposalItems,
	trackRequestBody,
	type ChatTrackExisting,
	type ChatTrackProposal,
} from "./chat-track-utils";
import { draftOf, EXCERPT_BYTES } from "./draft";
import { refusalOf } from "./errors";
import { addSubscription } from "./manual";
import { managedMailboxes, managedMessage, type FinanceAnswer, type FinanceUser } from "./manual-context";
import { addDocument } from "./manual-documents";
import type { ManualDraft } from "./manual-utils";
import type { SubscriptionRow } from "./record-utils";
import { subscriptionRef } from "./record-utils";
import { ownerDocuments, ownerRows } from "./subscriptions";
import { visibleToCaller } from "./tools";
import { manualVendorKey, senderAddress, vendorKey, vendorName } from "./vendor-utils";

/** A refusal the assistant can read and say in its own words; the tool and the card never fail silently. */
class ChatTrackRefusal extends Error {}

const refused = (error: string): JsonValue => ({ result: null, refused: { error } });

const EMAIL_NOT_FOUND = "Email not found in this mailbox, or you do not have full access to it";
const AI_OFF = "AI is off for this mailbox";
/** Shown only to the user who approved a card, never answered to the assistant. */
const HIDDEN_TRACKED =
	"This service is already tracked in Money Watch from a mailbox with AI off; add the email to it on the Subscriptions page";

/** The signed-in user the chat acts for, with the address mailbox access is checked by. */
async function chatUser(ctx: CapabilityCallContext): Promise<FinanceUser> {
	if (!ctx.viewer) throw new ChatTrackRefusal("Money Watch needs a signed-in user");
	const profile = await moduleHost.users.getProfile(ctx, ctx.viewer.userId);
	if (!profile) throw new ChatTrackRefusal("Money Watch needs a signed-in user");
	return {
		id: ctx.viewer.userId,
		email: profile.email,
		role: ctx.viewer.role,
		isPrimaryAdmin: ctx.viewer.isPrimaryAdmin,
		timeZone: ctx.timeZone,
	};
}

/**
 * The email the chat names, only when it lies in the chat's own mailbox, the user has full access to that mailbox
 * (as for Track as subscription) and AI is not off for it. The body is read only after those checks.
 */
async function chatMessage(
	ctx: CapabilityCallContext,
	user: FinanceUser,
	emailId: string,
	withText: boolean,
): Promise<HostMessageDetail> {
	const managed = await managedMailboxes(user);
	const message = await managedMessage(user, managed, emailId);
	if (!message || !ctx.mailboxIds?.includes(message.mailboxId)) throw new ChatTrackRefusal(EMAIL_NOT_FOUND);
	const [hidden] = await moduleHost.mail.aiHidden(ctx, [{ mailboxIds: [message.mailboxId], messageIds: [message.id] }]);
	if (hidden) throw new ChatTrackRefusal(AI_OFF);
	if (!withText) return message;
	const read = await managedMessage(user, managed, emailId, { maxBytes: EXCERPT_BYTES });
	if (!read) throw new ChatTrackRefusal(EMAIL_NOT_FOUND);
	return read;
}

/** Whether the chat may show a tracked row: nothing in it came from a mailbox with AI off. */
async function visibleRow(ctx: CapabilityCallContext, row: SubscriptionRow): Promise<boolean> {
	const { rows } = await visibleToCaller(ctx, [row], await ownerDocuments(row.userId, row.id));
	return rows.length === 1;
}

const existingOf = (row: SubscriptionRow): ChatTrackExisting => ({
	id: row.id,
	vendor: row.vendor,
	plan: row.plan,
	amountMinor: row.amountMinor,
	currency: row.currency,
	cycle: row.cycle,
});

type Service = { vendorKeys: string[]; vendor: string | null; plan: string | null; matchedId: string | null };

/**
 * The owner's tracked row for the same service among `rows`, or null: the detector's own match for an email, else the
 * row with the sender's vendor key or the name typed by hand, else the row with the same name.
 */
function sameService(rows: readonly SubscriptionRow[], service: Service): SubscriptionRow | null {
	const keys = [...service.vendorKeys, ...(service.vendor ? [manualVendorKey(service.vendor)] : [])];
	const matched = service.matchedId ? rows.find((row) => row.id === service.matchedId) : null;
	if (matched) return matched;
	const found = findExisting(rows, { ...service, vendorKeys: keys });
	return found ? (rows.find((row) => row.id === found.id) ?? null) : null;
}

/**
 * The tracked rows the chat may show: nothing in them came from a mailbox with AI off. The preview matches only
 * these, so a row from such a mailbox looks untracked to the assistant, which cannot probe for it by name.
 */
async function visibleRows(ctx: CapabilityCallContext, user: FinanceUser): Promise<SubscriptionRow[]> {
	const [rows, documents] = await Promise.all([ownerRows(user.id), ownerDocuments(user.id)]);
	return (await visibleToCaller(ctx, rows, documents)).rows;
}

/**
 * On approval, the tracked row for the same service among all of the owner's rows. A row the chat may not see still
 * stops a second one; the refusal goes to the user who clicked, never into the chat the assistant reads.
 */
async function trackedOnApproval(
	ctx: CapabilityCallContext,
	user: FinanceUser,
	service: Service,
): Promise<ChatTrackExisting | null> {
	const row = sameService(await ownerRows(user.id), service);
	if (row && !(await visibleRow(ctx, row))) throw new ChatTrackRefusal(HIDDEN_TRACKED);
	return row ? existingOf(row) : null;
}

/** The sender's vendor key, as Track as subscription stores it, so the dedupe matches what saving would. */
function senderKeys(message: HostMessageDetail, draft: ManualDraft | null): string[] {
	// The draft's key names a processor's merchant; a row tracked before that keeps the display name's key.
	const named = vendorKey(message.from, vendorName(message.fromName, message.from).vendor);
	return [...new Set([draft?.vendorKey, named].filter((key): key is string => !!key))];
}

/** Refusals, the pending database update among them, become the `refused` answer; anything else still fails the call. */
async function answeringRefusals(run: () => Promise<JsonValue>): Promise<JsonValue> {
	try {
		return await run();
	} catch (error) {
		if (error instanceof ChatTrackRefusal) return refused(error.message);
		const refusal = refusalOf(error);
		if (refusal) return refused(refusal.error);
		throw error;
	}
}

/**
 * The email the call names and the detector's reading of it, or neither for a subscription typed in the chat. A
 * tracked row the chat may not see is no match for the reading either.
 */
async function readEmail(
	ctx: CapabilityCallContext,
	user: FinanceUser,
	emailId: string | undefined,
	visible: readonly SubscriptionRow[],
) {
	if (!emailId) return { message: null, draft: null };
	const message = await chatMessage(ctx, user, emailId, true);
	const ids = new Set(visible.map((row) => row.id));
	return { message, draft: await draftOf(user, message, (id) => ids.has(id)) };
}

const SUBJECT_MAX = 200;

/** The subject and sender the card names the email by. */
function emailLine(message: HostMessageDetail) {
	return {
		subject: message.subject ? message.subject.slice(0, SUBJECT_MAX) : null,
		from: message.fromName ? `${message.fromName} <${senderAddress(message.from)}>` : senderAddress(message.from),
	};
}

/** The host a cancel link opens, as Track as subscription shows it; null without one. */
function linkHost(url: string | null | undefined): string | null {
	if (!url) return null;
	try {
		return new URL(url).host;
	} catch {
		return null;
	}
}

function attachmentName(message: HostMessageDetail | null, draft: ManualDraft | null): string | null {
	const id = draft?.document?.attachmentId;
	return (id && message?.attachments.find((item) => item.id === id)?.filename) || null;
}

function serviceOf(input: ChatTrackInput, message: HostMessageDetail | null, draft: ManualDraft | null): Service {
	return {
		vendorKeys: message ? senderKeys(message, draft) : [],
		vendor: draft?.vendor || input.vendor || null,
		plan: draft?.plan ?? input.plan ?? null,
		matchedId: draft?.subscriptionId ?? null,
	};
}

/** The card's input and what it shows besides: the email it reads and the cancel link saving takes from it. */
function cardOf(
	input: ChatTrackInput,
	message: HostMessageDetail | null,
	draft: ManualDraft | null,
	row: SubscriptionRow | null,
) {
	const { proposal, details } = mergeProposal(
		draft,
		input,
		row ? existingOf(row) : null,
		attachmentName(message, draft),
	);
	return {
		proposal,
		details: {
			...details,
			email: message ? emailLine(message) : null,
			cancelLinkHost: proposal.mode === "track" ? linkHost(draft?.cancelLink?.url) : null,
		},
	};
}

/**
 * The approval preview of `track_subscription`: what Kite reads from the email, the assistant's values only where
 * the email states nothing, and the tracked subscription it would add the email to instead of tracking it twice.
 * Writes nothing. The answer's `input` replaces the model's, so the card shows and runs exactly these fields.
 */
export const previewTrackSubscription: CapabilityHandler = async (raw, ctx) =>
	answeringRefusals(async () => {
		const parsed = chatTrackInputSchema.safeParse((raw as { input?: unknown }).input);
		if (!parsed.success) return refused(parsed.error.issues[0]?.message ?? "Invalid input");
		const input: ChatTrackInput = parsed.data;
		if (!input.emailId && !input.vendor)
			return refused("Name the service to track, or open the email with the receipt");
		const user = await chatUser(ctx);
		if (input.emailId) await chatMessage(ctx, user, input.emailId, false);
		const visible = await visibleRows(ctx, user);
		const { message, draft } = await readEmail(ctx, user, input.emailId, visible);
		const row = sameService(visible, serviceOf(input, message, draft));
		// Without an email there is nothing to add to a tracked subscription, so say so rather than show a card that
		// cannot be approved.
		if (row && !input.emailId)
			return refused(
				`${row.vendor} is already tracked in Money Watch; open the email with the receipt and ask again to add it there`,
			);
		const { proposal, details } = cardOf(input, message, draft, row);
		return {
			items: proposalItems(proposal, details, ctx.locale),
			input: proposal,
			details,
		} as unknown as JsonValue;
	});

/** Every field of the approved input explicit, as the card showed it. */
function proposalOf(input: ChatTrackInput): ChatTrackProposal {
	return {
		...(input.emailId ? { emailId: input.emailId } : {}),
		mode: input.mode ?? "track",
		subscriptionId: input.subscriptionId ?? null,
		vendor: input.vendor ?? null,
		plan: input.plan ?? null,
		amount: input.amount ?? null,
		currency: input.currency ?? null,
		cycle: input.cycle ?? null,
		nextRenewalOn: input.nextRenewalOn ?? null,
		docType: input.docType ?? null,
		documentOn: input.documentOn ?? null,
		attachmentId: input.attachmentId ?? null,
	};
}

function answerResult(answer: FinanceAnswer, status: "tracked" | "recorded", subscriptionId: string): JsonValue {
	if (answer.status !== 200) {
		const code = answer.body.code;
		if (code === "DOCUMENT_EXISTS") return refused("This email is already recorded for that subscription");
		return refused(String(answer.body.error ?? "Money Watch could not save this"));
	}
	const body = answer.body as { actionId?: string; documentRecorded?: boolean | null };
	return {
		result: {
			status,
			actionId: String(body.actionId ?? ""),
			subscription: subscriptionRef(subscriptionId),
			documentRecorded: status === "recorded" ? true : (body.documentRecorded ?? null),
		},
	};
}

async function attach(ctx: CapabilityCallContext, user: FinanceUser, proposal: ChatTrackProposal) {
	const rows = await ownerRows(user.id);
	const row = rows.find((candidate) => candidate.id === proposal.subscriptionId);
	if (!row) throw new ChatTrackRefusal("That tracked subscription is no longer there; ask again");
	if (!(await visibleRow(ctx, row))) throw new ChatTrackRefusal(HIDDEN_TRACKED);
	const request = attachRequestBody(proposal);
	if ("error" in request) throw new ChatTrackRefusal(request.error);
	return answerResult(await addDocument(user, row.id, request.body), "recorded", row.id);
}

async function track(
	ctx: CapabilityCallContext,
	user: FinanceUser,
	proposal: ChatTrackProposal,
	message: HostMessageDetail | null,
) {
	const mailboxId = message?.mailboxId ?? ctx.mailboxIds?.[0];
	if (!mailboxId) throw new ChatTrackRefusal(EMAIL_NOT_FOUND);
	// Tracked meanwhile (another card, another chat): never a second row for the same service.
	const existing = await trackedOnApproval(ctx, user, {
		vendorKeys: message ? senderKeys(message, null) : [],
		vendor: proposal.vendor,
		plan: proposal.plan,
		matchedId: null,
	});
	if (existing)
		throw new ChatTrackRefusal(`${existing.vendor} is already tracked; ask again to add this email to it instead`);
	const request = trackRequestBody(proposal, { mailboxId });
	if ("error" in request) throw new ChatTrackRefusal(request.error);
	const answer = await addSubscription(user, request.body);
	const subscription = (answer.body.subscription as { id?: string } | null | undefined)?.id ?? "";
	return answerResult(answer, "tracked", subscription);
}

/**
 * `track_subscription`, run only once the user approved its card (`approval.preview`): tracks the subscription as
 * `create_subscription`, with the email as its first document when its type and amount are known, or adds the email
 * to the tracked subscription for the same service as `record_document`. Both go through the executor like Track
 * as subscription, so they show in Activity and can be undone; the chat card offers Undo.
 */
export const trackSubscriptionTool: CapabilityHandler = async (raw, ctx) =>
	answeringRefusals(async () => {
		const proposal = proposalOf(chatTrackInputSchema.parse(raw));
		const user = await chatUser(ctx);
		const message = proposal.emailId ? await chatMessage(ctx, user, proposal.emailId, false) : null;
		return proposal.mode === "attach" ? attach(ctx, user, proposal) : track(ctx, user, proposal, message);
	});

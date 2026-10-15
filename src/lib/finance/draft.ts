import type { HostMessageDetail } from "@/lib/modules/host-types";
import { detectBodySchema } from "./api-schemas";
import { parseCancelLink } from "./cancel-link-utils";
import { MigrationPending, detectionContext } from "./detect";
import { analyzeMessage } from "./detect-utils";
import { MIGRATION_PENDING_ERROR } from "./errors";
import {
	fail,
	managedMailboxes,
	managedMessage,
	notFound,
	ok,
	parseBody,
	sessionContext,
	type FinanceAnswer,
	type FinanceUser,
} from "./manual-context";
import { draftFromAnalysis, type ManualDraft } from "./manual-utils";
import type { DetectStepInput } from "./types";
import { vendorName } from "./vendor-utils";

/** The same bounded excerpt the triage step reads (spec §5.2). */
const EXCERPT_BYTES = 8_192;

function stepInput(message: HostMessageDetail): DetectStepInput {
	return {
		message: {
			id: message.id,
			mailboxId: message.mailboxId,
			from: message.from,
			fromName: message.fromName,
			subject: message.subject,
			receivedAt: message.receivedAt,
			textExcerpt: message.textExcerpt ?? null,
		},
		// The user asked for this message, so nothing about it is held back.
		facts: {
			authPassed: true,
			bulk: false,
			knownContact: false,
			phishing: [],
			automatic: false,
			noReply: false,
			list: false,
			spam: false,
		},
		headers: {
			listUnsubscribe: message.headers?.["list-unsubscribe"] ?? null,
			listUnsubscribePost: message.headers?.["list-unsubscribe-post"] ?? null,
			listId: null,
		},
		attachments: message.attachments,
		model: null,
	};
}

/** A draft for a sender without a domain to key a vendor by: the vendor name and the cancel link only. */
function bareDraft(input: DetectStepInput): ManualDraft {
	return {
		vendor: vendorName(input.message.fromName, input.message.from).vendor,
		vendorKey: null,
		plan: null,
		amountMinor: null,
		currency: null,
		cycle: null,
		nextRenewalOn: null,
		renewalEstimated: false,
		trialEndsOn: null,
		cancelLink: parseCancelLink(input.headers.listUnsubscribe, input.headers.listUnsubscribePost),
		document: null,
		subscriptionId: null,
	};
}

async function draftOf(user: FinanceUser, message: HostMessageDetail): Promise<ManualDraft> {
	const ctx = sessionContext(user, [message.mailboxId]);
	const input = stepInput(message);
	const analysis = analyzeMessage(input, ctx.timeZone);
	if (!analysis) return bareDraft(input);
	return draftFromAnalysis(analysis, await detectionContext(ctx, input, analysis, user.id));
}

/**
 * `POST /api/finance/detect`: runs the detector on one message the user manages and answers the
 * prefilled fields for "Track as subscription" and "Add to a tracked subscription". Writes nothing.
 */
export async function detectDraft(user: FinanceUser, raw: unknown): Promise<FinanceAnswer> {
	const parsed = parseBody(detectBodySchema, raw);
	if ("answer" in parsed) return parsed.answer;
	const message = await managedMessage(user, await managedMailboxes(user), parsed.data.messageId, {
		maxBytes: EXCERPT_BYTES,
	});
	if (!message) return notFound("Message not found");
	try {
		return ok({
			messageId: message.id,
			mailboxId: message.mailboxId,
			draft: await draftOf(user, message),
			attachments: message.attachments.map(({ id, filename, contentType, size }) => ({
				id,
				filename,
				contentType,
				size,
			})),
		});
	} catch (error) {
		if (error instanceof MigrationPending) return fail(409, MIGRATION_PENDING_ERROR, "MIGRATION_PENDING");
		throw error;
	}
}

import type { CapabilityCallContext, CapabilityHandler, JsonValue } from "@/lib/modules/module-types";
import { analyzeWithAttachments } from "./detect";
import { mergeDetection, modelExtensionOf, parseModelExtraction } from "./model-utils";
import { detectPayment, paymentBlocked } from "./payment-utils";
import { insertPayment, messageRecorded, paymentId, paymentTablesReady, tracksVendor } from "./payments";
import { dayToDate } from "./record-utils";
import { emitPaymentRecorded } from "./webhook-events";
import type { DetectStepInput } from "./types";

export type RecordOutcome = "recorded" | "skipped" | "migration_pending";

/**
 * Records the payment document a message is, for its reviewer (spec §25): the same analysis as subscription
 * detection, merged with a validated model extension when the triage request carried one. A message that is a tracked
 * subscription's, already in its ledger or already recorded (a removed row included) records nothing.
 */
export async function recordPaymentFromInput(
	ctx: CapabilityCallContext,
	input: DetectStepInput,
	source: "auto" | "scan",
): Promise<RecordOutcome> {
	const userId = ctx.viewer?.userId;
	if (!userId || paymentBlocked(input)) return "skipped";
	if (!(await paymentTablesReady())) return "migration_pending";
	const { input: read, deterministic } = await analyzeWithAttachments(ctx, input);
	if (!deterministic) return "skipped";
	const extraction = parseModelExtraction(modelExtensionOf(read), {
		messageDay: deterministic.dates.messageDay,
		paymentFailed: deterministic.paymentFailed,
	});
	const finding = detectPayment(mergeDetection(deterministic, extraction), deterministic, read);
	if (!finding) return "skipped";
	if (await tracksVendor(userId, [finding.vendorKey, ...deterministic.vendorKeys])) return "skipped";
	if (await messageRecorded(userId, input.message.id)) return "skipped";
	const now = new Date();
	const id = await paymentId(userId, input.message.id);
	const recorded = await insertPayment({
		id,
		userId,
		mailboxId: input.message.mailboxId,
		messageId: input.message.id,
		attachmentId: finding.attachmentId,
		vendor: finding.vendor,
		vendorKey: finding.vendorKey,
		docType: finding.docType,
		status: finding.status,
		amountMinor: finding.amountMinor,
		currency: finding.currency,
		documentAt: dayToDate(finding.documentOn)!,
		source,
		docRef: finding.docRef,
		mailRef: finding.mailRef,
		modelFields: finding.modelFields.length > 0 ? JSON.stringify(finding.modelFields) : null,
		category: finding.category,
		createdAt: now,
		updatedAt: now,
	});
	if (!recorded) return "skipped";
	await emitPaymentRecorded(ctx, { id, finding, source, messageId: input.message.id });
	return "recorded";
}

/**
 * The `recordPayment` triage step: writes the payment row itself, without a card, into the module's own table. It
 * never offers a suggestion; before migration 0094 it reports `migration_pending`.
 */
export const recordPaymentStep: CapabilityHandler = async (raw, ctx): Promise<JsonValue> => {
	if (!ctx.viewer) throw new Error("The payment step needs a reviewer");
	const outcome = await recordPaymentFromInput(ctx, raw as DetectStepInput, "auto");
	return outcome === "migration_pending" ? { suggestions: [], skipped: "migration_pending" } : { suggestions: [] };
};

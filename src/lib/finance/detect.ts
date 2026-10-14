import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { financeSubscriptions } from "@/db/schema/finance";
import { getEnv } from "@/lib/cloudflare";
import { moduleHost } from "@/lib/modules/host";
import type { CapabilityCallContext, CapabilityHandler, JsonValue } from "@/lib/modules/module-types";
import { isNoSuchTableError } from "@/lib/modules/state-utils";
import {
	analyzeMessage,
	buildDetection,
	matchTracked,
	needsHistory,
	recurringCycle,
	skipsMessage,
	wantsModelForReceipt,
	type Analysis,
	type DetectionContext,
} from "./detect-utils";
import { mergeDetection, modelExtensionOf, parseModelExtraction } from "./model-utils";
import { suggestionTitle } from "./text-utils";
import type { DetectStepInput, TrackedMatchRow } from "./types";
import { senderAddress } from "./vendor-utils";

/** Earlier mail from the sender is read only this far back (spec §5.6). */
const HISTORY_DAYS = 400;
const HISTORY_LIMIT = 5;

export class MigrationPending extends Error {}

async function trackedRows(userId: string, key: string): Promise<TrackedMatchRow[]> {
	try {
		return await getDb(getEnv())
			.select({
				id: financeSubscriptions.id,
				vendorKey: financeSubscriptions.vendorKey,
				plan: financeSubscriptions.plan,
				amountMinor: financeSubscriptions.amountMinor,
				currency: financeSubscriptions.currency,
				cycle: financeSubscriptions.cycle,
			})
			.from(financeSubscriptions)
			.where(and(eq(financeSubscriptions.userId, userId), eq(financeSubscriptions.vendorKey, key)));
	} catch (error) {
		if (isNoSuchTableError(error)) throw new MigrationPending();
		throw error;
	}
}

async function senderHistory(ctx: CapabilityCallContext, input: DetectStepInput) {
	return moduleHost.mail.recentFromSender(ctx, {
		mailboxId: input.message.mailboxId,
		sender: senderAddress(input.message.from),
		before: input.message.receivedAt,
		sinceDays: HISTORY_DAYS,
		limit: HISTORY_LIMIT,
	});
}

/** Whether a message could become a card at all, before any database read. */
function worthMatching(analysis: Analysis): boolean {
	return !!analysis.amount || analysis.paymentFailed;
}

/**
 * The owner's tracked row a message is about and, only without one, the cycle the sender's earlier
 * mail implies. Matching reads the merged analysis; whether history is read depends on what the
 * detector alone found (`deterministic`, the same analysis without a model). Throws `MigrationPending`
 * before migration 0063.
 */
export async function detectionContext(
	ctx: CapabilityCallContext,
	input: DetectStepInput,
	analysis: Analysis,
	userId: string,
	deterministic: Analysis = analysis,
): Promise<DetectionContext> {
	const tracked = matchTracked(await trackedRows(userId, analysis.vendorKey), analysis);
	const recurring =
		!tracked && needsHistory(deterministic)
			? recurringCycle(deterministic, await senderHistory(ctx, input), ctx.timeZone)
			: null;
	return { tracked, recurring };
}

async function detectFor(ctx: CapabilityCallContext, input: DetectStepInput, userId: string) {
	const deterministic = analyzeMessage(input, ctx.timeZone);
	if (!deterministic) return null;
	const extraction = parseModelExtraction(modelExtensionOf(input), {
		messageDay: deterministic.dates.messageDay,
		paymentFailed: deterministic.paymentFailed,
	});
	const merged = mergeDetection(deterministic, extraction);
	if (!worthMatching(merged)) return null;
	const context = await detectionContext(ctx, input, merged, userId, deterministic);
	// A cycle from the sender's own history is confident, so it is merged before any model cycle.
	const analysis =
		context.recurring && !deterministic.cycle
			? mergeDetection({ ...deterministic, cycle: context.recurring }, extraction)
			: merged;
	return buildDetection(analysis, context);
}

/** The `wantsModel` service: whether a receipt the detector cannot complete is worth a model request. */
export const wantsModelStep: CapabilityHandler = async (raw, ctx): Promise<JsonValue> => ({
	wantsModel: wantsModelForReceipt(raw as DetectStepInput, ctx.timeZone),
});

/**
 * The `detect` triage step: reads the message's billing evidence deterministically and offers at most
 * one `subscription` card. Phishing-flagged and spam mail get nothing; before migration 0063 the step
 * reports `migration_pending`. Nothing about an untracked vendor is stored here.
 */
export const detectSubscriptionStep: CapabilityHandler = async (raw, ctx): Promise<JsonValue> => {
	if (!ctx.viewer) throw new Error("The detect step needs a reviewer");
	const input = raw as DetectStepInput;
	if (skipsMessage(input.facts)) return { suggestions: [] };
	let detection: Awaited<ReturnType<typeof detectFor>>;
	try {
		detection = await detectFor(ctx, input, ctx.viewer.userId);
	} catch (error) {
		if (error instanceof MigrationPending) return { suggestions: [], skipped: "migration_pending" };
		throw error;
	}
	if (!detection) return { suggestions: [] };
	return {
		suggestions: [
			{
				kind: "subscription",
				payload: detection.payload as unknown as JsonValue,
				reason: detection.reason,
				title: suggestionTitle(detection.payload, ctx.locale),
			},
		],
	};
};

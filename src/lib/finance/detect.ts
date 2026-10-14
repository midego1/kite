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
	type Analysis,
} from "./detect-utils";
import { suggestionTitle } from "./text-utils";
import type { DetectStepInput, TrackedMatchRow } from "./types";
import { senderAddress } from "./vendor-utils";

/** Earlier mail from the sender is read only this far back (spec §5.6). */
const HISTORY_DAYS = 400;
const HISTORY_LIMIT = 5;

class MigrationPending extends Error {}

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

async function detectFor(ctx: CapabilityCallContext, input: DetectStepInput, userId: string) {
	const analysis = analyzeMessage(input, ctx.timeZone);
	if (!analysis || !worthMatching(analysis)) return null;
	const tracked = matchTracked(await trackedRows(userId, analysis.vendorKey), analysis);
	const recurring =
		!tracked && needsHistory(analysis) ? recurringCycle(analysis, await senderHistory(ctx, input), ctx.timeZone) : null;
	return buildDetection(analysis, { tracked, recurring });
}

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

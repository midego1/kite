import { and, eq, gte, isNull, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { inJsonArray } from "@/db/chunk-utils";
import { mailboxAgentSettings, mailboxes, messages } from "@/db/schema";
import { aiOffMailboxIds } from "@/lib/agent/mailbox-ai";
import { getAutoReadInstallSettings } from "@/lib/agent/auto-read/install-settings";
import { isPaused } from "@/lib/agent/auto-read/schedule-utils";
import { resolveMailboxAgentSettings } from "@/lib/agent/auto-read/settings-utils";
import { stepSwitchOn } from "@/lib/agent/auto-read/module-steps-utils";
import { getEnv } from "@/lib/cloudflare";

/** The Payments triage step's own switch key (spec money-watch.md §25.4), on unless set to false. */
const PAYMENTS_STEP = { moduleId: "finance" as const, switchKey: "payments" };
/** Inbound mail a reader has kept, same as the backfill the scan itself reads (`backfillMessages`). */
const COVERED_STATUSES = ["received", "archived"] as const;

export type ScanCoverageGap =
	| { reason: "automatic_reading_off"; messages: number }
	| { reason: "no_authentication"; messages: number }
	| { reason: "different_reviewer"; messages: number };

async function ownedMailboxes(userId: string) {
	const env = getEnv();
	const db = getDb(env);
	return db
		.select({ mailbox: mailboxes, settings: mailboxAgentSettings })
		.from(mailboxes)
		.leftJoin(mailboxAgentSettings, eq(mailboxAgentSettings.mailboxId, mailboxes.id))
		.where(and(eq(mailboxes.userId, userId), eq(mailboxes.disabled, false)));
}

async function countCovered(mailboxIds: readonly string[], since: Date, extra: SQL): Promise<number> {
	if (mailboxIds.length === 0) return 0;
	const env = getEnv();
	const [row] = await getDb(env)
		.select({ count: sql<number>`count(*)` })
		.from(messages)
		.where(
			and(
				inJsonArray(messages.mailboxId, mailboxIds),
				eq(messages.direction, "inbound"),
				inJsonArray(messages.status, COVERED_STATUSES),
				gte(messages.createdAt, since),
				extra,
			),
		);
	return Number(row?.count ?? 0);
}

/**
 * Inbound mail in the last `SCAN_DAYS` that "Scan last 90 days" never records, and why — read here only to explain
 * a gap, never to widen what the scan itself covers. One mailbox the viewer does not own (a shared mailbox where
 * someone else is reviewer) is not counted: the owner cannot fix that mailbox's automatic reading from their own
 * settings.
 *
 * Three causes, kept apart so the tab never tells someone that turning on automatic reading will fix mail it cannot:
 * - `automatic_reading_off`: the mailbox is not eligible for automatic reading (spec money-watch.md §25.5: autonomy
 *   off, paused, AI off for the mailbox, or the Payments switch off there, or automatic reading off for the whole
 *   install, which overrides every mailbox's own settings), the same rule `backfillMessages` applies. Counted only
 *   for mail that went through live delivery's spam and authentication analysis (`spam_signals` set), since that is
 *   the mail turning automatic reading on would actually let the scan read.
 * - `different_reviewer`: the owner's own mailbox, but its automatic reading was handed to a different reviewer
 *   (`mailboxAgentSettings.reviewerUserId`); `backfillMessages` reads a mailbox only for the viewer its settings
 *   name as reviewer (the owner, unless reassigned), so this owner's scan skips it whatever its autonomy says.
 *   Turning on automatic reading would not help either: only taking reviewership back would.
 * - `no_authentication`: mail imported or synced from a connected account never runs through that analysis, so
 *   `spam_signals` stays null and `facts.authPassed` is always false; `paymentBlocked` (§25.1, "spoofed mail must not
 *   write a row without a click") then blocks it whatever the mailbox's automatic reading settings are. Counted
 *   across every owned mailbox, eligible or not, since the mailbox's settings make no difference here. Not yet
 *   fixed: real authentication for mail Kite did not see delivered (follow-up).
 *
 * Both the first two causes exclude unauthenticated mail, which is always `no_authentication` instead, so the same
 * message is never counted twice.
 */
export async function scanCoverageGaps(userId: string, since: Date): Promise<ScanCoverageGap[]> {
	const rows = await ownedMailboxes(userId);
	if (rows.length === 0) return [];
	const owned = rows.map((row) => row.mailbox.id);
	const env = getEnv();
	const install = await getAutoReadInstallSettings(env);
	let ineligible: string[];
	let reviewedElsewhere: string[];
	if (!install.agentEnabled || !install.autoReadEnabled) {
		// `resolveEligible` returns no mailbox at all while automatic reading is off for the install, whatever each
		// mailbox's own settings (or reviewer) say, so every owned mailbox is ineligible here too.
		ineligible = owned;
		reviewedElsewhere = [];
	} else {
		const off = await aiOffMailboxIds(getDb(env), owned);
		ineligible = [];
		reviewedElsewhere = [];
		for (const { mailbox, settings } of rows) {
			if ((settings?.reviewerUserId ?? mailbox.userId) !== userId) {
				reviewedElsewhere.push(mailbox.id);
				continue;
			}
			const resolved = resolveMailboxAgentSettings(settings ?? undefined, {
				mailboxId: mailbox.id,
				ownerUserId: mailbox.userId,
				mailboxType: mailbox.type,
			});
			if (
				resolved.autonomy === "off" ||
				isPaused(resolved.pausedUntil) ||
				off.has(mailbox.id) ||
				!stepSwitchOn(PAYMENTS_STEP, resolved.capabilities)
			)
				ineligible.push(mailbox.id);
		}
	}
	const analyzed = sql`${messages.spamSignals} is not null`;
	const [autoReadOff, differentReviewer, noAuth] = await Promise.all([
		countCovered(ineligible, since, analyzed),
		countCovered(reviewedElsewhere, since, analyzed),
		countCovered(owned, since, isNull(messages.spamSignals)),
	]);
	const gaps: ScanCoverageGap[] = [];
	if (autoReadOff > 0) gaps.push({ reason: "automatic_reading_off", messages: autoReadOff });
	if (differentReviewer > 0) gaps.push({ reason: "different_reviewer", messages: differentReviewer });
	if (noAuth > 0) gaps.push({ reason: "no_authentication", messages: noAuth });
	return gaps;
}

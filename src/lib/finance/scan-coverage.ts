import { and, eq, gte, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { inJsonArray } from "@/db/chunk-utils";
import { mailboxAgentSettings, mailboxes, messages } from "@/db/schema";
import { aiOffMailboxIds } from "@/lib/agent/mailbox-ai";
import { isPaused } from "@/lib/agent/auto-read/schedule-utils";
import { resolveMailboxAgentSettings } from "@/lib/agent/auto-read/settings-utils";
import { stepSwitchOn } from "@/lib/agent/auto-read/module-steps-utils";
import { getEnv } from "@/lib/cloudflare";

/** The Payments triage step's own switch key (spec money-watch.md §25.4), on unless set to false. */
const PAYMENTS_STEP = { moduleId: "finance" as const, switchKey: "payments" };
/** Inbound mail a reader has kept, same as the backfill the scan itself reads (`backfillMessages`). */
const COVERED_STATUSES = ["received", "archived"] as const;

export type ScanCoverageGap = { reason: "automatic_reading_off"; messages: number };

/**
 * Inbound mail in the last `SCAN_DAYS` that "Scan last 90 days" never reads because the owner's mailbox is not
 * eligible for automatic reading (spec money-watch.md §25.5: autonomy off, paused, AI off for the mailbox, or the
 * Payments switch off there) — the same rule `backfillMessages` applies, read here only to explain a gap, never to
 * widen what the scan itself covers. One mailbox the viewer does not own (a shared mailbox where someone else is
 * reviewer) is not counted: the owner cannot fix that mailbox's automatic reading from their own settings.
 */
export async function scanCoverageGaps(userId: string, since: Date): Promise<ScanCoverageGap[]> {
	const env = getEnv();
	const db = getDb(env);
	const rows = await db
		.select({ mailbox: mailboxes, settings: mailboxAgentSettings })
		.from(mailboxes)
		.leftJoin(mailboxAgentSettings, eq(mailboxAgentSettings.mailboxId, mailboxes.id))
		.where(and(eq(mailboxes.userId, userId), eq(mailboxes.disabled, false)));
	if (rows.length === 0) return [];
	const off = await aiOffMailboxIds(
		db,
		rows.map((row) => row.mailbox.id),
	);
	const ineligible = rows
		.filter(({ mailbox, settings }) => {
			const resolved = resolveMailboxAgentSettings(settings ?? undefined, {
				mailboxId: mailbox.id,
				ownerUserId: mailbox.userId,
				mailboxType: mailbox.type,
			});
			if (resolved.autonomy === "off" || isPaused(resolved.pausedUntil) || off.has(mailbox.id)) return true;
			return !stepSwitchOn(PAYMENTS_STEP, resolved.capabilities);
		})
		.map(({ mailbox }) => mailbox.id);
	if (ineligible.length === 0) return [];
	const [row] = await db
		.select({ count: sql<number>`count(*)` })
		.from(messages)
		.where(
			and(
				inJsonArray(messages.mailboxId, ineligible),
				eq(messages.direction, "inbound"),
				inJsonArray(messages.status, COVERED_STATUSES),
				gte(messages.createdAt, since),
			),
		);
	const count = Number(row?.count ?? 0);
	return count > 0 ? [{ reason: "automatic_reading_off", messages: count }] : [];
}

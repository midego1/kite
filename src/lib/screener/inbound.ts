import { eq } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { mailboxes } from "@/db/schema";
import { getScreenerSettings, getSenderDecision, screenerOwnAddresses } from "./settings";
import { isScreenerExempt, SCREENING_STATUS, screenerAddress, screenerVerdict } from "./screener-utils";

/**
 * The status a delivered message is stored with once the Screener has seen it, and whether it waits for a
 * decision (held, or marked as a new sender in Inbox mode). Mail waiting for a decision gets no new-mail
 * notification, auto-reply or automatic reading until its sender is approved.
 */
export async function applyScreener(
	db: AppDatabase,
	input: { mailboxId: string; sender: string; status: string },
): Promise<{ status: string; awaiting: boolean }> {
	const unchanged = { status: input.status, awaiting: false };
	if (input.status !== "received") return unchanged;
	const settings = await getScreenerSettings(db, input.mailboxId);
	const sender = screenerAddress(input.sender);
	if (!settings?.enabled || !sender) return unchanged;
	const [mailbox] = await db.select().from(mailboxes).where(eq(mailboxes.id, input.mailboxId)).limit(1);
	const own = await screenerOwnAddresses(db, mailbox);
	const verdict = screenerVerdict({
		settings,
		status: input.status,
		sender,
		exempt: isScreenerExempt(sender, own),
		decision: await getSenderDecision(db, input.mailboxId, sender),
	});
	if (verdict === "hold") return { status: SCREENING_STATUS, awaiting: true };
	if (verdict === "mark") return { status: input.status, awaiting: true };
	if (verdict === "spam") return { status: "spam", awaiting: false };
	return unchanged;
}

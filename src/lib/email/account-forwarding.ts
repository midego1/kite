import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { getEmailAddress } from "@/lib/email/address";
import { resolveInboundAddress } from "@/lib/email/routing";
import { createLogger } from "@/lib/logger.mjs";

const logger = createLogger("account-forwarding");

export const KITE_FORWARDED_HEADER = "X-Kite-Forwarded";
// Set by installs from before the rename to Kite, which may still forward to this one.
const LEGACY_FORWARDED_HEADER = "X-Mailflare-Forwarded";

/** True when a Kite install already forwarded this message, so account forwarding must not loop it. */
export function wasForwardedByKite(header: (name: string) => string | null | undefined): boolean {
	return [KITE_FORWARDED_HEADER, LEGACY_FORWARDED_HEADER].some(
		(name) => header(name) === "1" || header(name.toLowerCase()) === "1",
	);
}

/**
 * The account forwarding address for mail to `recipient`, or null. Never throws, like `resolveIncomingMail`: when the
 * database cannot be read the message is still stored (and not forwarded) instead of being refused.
 */
export async function getAccountForwardingDestination(env: CloudflareEnv, recipient: string): Promise<string | null> {
	try {
		return await accountForwardingDestination(env, recipient);
	} catch (error) {
		logger.error("email.account_forwarding_lookup_failed", { error });
		return null;
	}
}

async function accountForwardingDestination(env: CloudflareEnv, recipient: string): Promise<string | null> {
	const db = getDb(env);
	const decision = await resolveInboundAddress(db, recipient);
	if (!decision?.mailbox) return null;
	const [account] = await db
		.select({ forwardingEmail: users.forwardingEmail })
		.from(users)
		.where(eq(users.id, decision.mailbox.userId))
		.limit(1);
	const destination = account?.forwardingEmail?.trim() ?? "";
	if (!destination || getEmailAddress(destination).toLowerCase() === getEmailAddress(recipient).toLowerCase()) {
		return null;
	}
	return destination;
}

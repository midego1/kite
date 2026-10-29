import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { appSettings, domains } from "@/db/schema";
import { listAccessibleMailboxes } from "@/lib/mailboxes/access";
import type { SessionUser } from "@/lib/auth/types";
import { getEmailAddress } from "./address";

export const DEFAULT_OUTBOUND_ATTACHMENT_MAX_MB = 25;
export const MAX_OUTBOUND_ATTACHMENT_MAX_MB = 25;
export const CLOUD_ATTACHMENT_THRESHOLD_BYTES = 3_000_000;

export async function getOutboundAttachmentMaxMb(env: CloudflareEnv): Promise<number> {
	const [settings] = await getDb(env)
		.select({ maxMb: appSettings.outboundAttachmentMaxMb })
		.from(appSettings)
		.where(eq(appSettings.id, "default"))
		.limit(1);
	return settings?.maxMb ?? DEFAULT_OUTBOUND_ATTACHMENT_MAX_MB;
}

/**
 * Whether a message from this address may have its big files turned into download links: only Cloudflare Email
 * Sending has the 5 MiB cap. Resend and SES take attachments directly, so the composer drops its warning for them.
 * Only domains of mailboxes the user can access are looked up, so the answer never says anything about another
 * account's domains; any other address, an unknown domain and one without a sending provider keep the Cloudflare
 * wording.
 */
export async function sendsThroughCloudflare(
	env: CloudflareEnv,
	user: Pick<SessionUser, "id" | "email" | "role">,
	fromAddress: string,
): Promise<boolean> {
	const hostname = getEmailAddress(fromAddress).split("@")[1]?.toLowerCase();
	if (!hostname) return true;
	const db = getDb(env);
	const domainIds = [...new Set((await listAccessibleMailboxes(db, user)).map((mailbox) => mailbox.domainId))];
	if (domainIds.length === 0) return true;
	const [domain] = await db
		.select({ provider: domains.sendingProvider })
		.from(domains)
		.where(and(eq(domains.hostname, hostname), inArray(domains.id, domainIds)))
		.limit(1);
	return !domain || domain.provider === "cloudflare" || domain.provider === "none";
}

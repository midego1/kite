import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { appSettings, domains } from "@/db/schema";
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
 * A domain that cannot be found keeps the Cloudflare wording, as does one without a sending provider.
 */
export async function sendsThroughCloudflare(env: CloudflareEnv, fromAddress: string): Promise<boolean> {
	const hostname = getEmailAddress(fromAddress).split("@")[1]?.toLowerCase();
	if (!hostname) return true;
	const [domain] = await getDb(env)
		.select({ provider: domains.sendingProvider })
		.from(domains)
		.where(eq(domains.hostname, hostname))
		.limit(1);
	return !domain || domain.provider === "cloudflare" || domain.provider === "none";
}

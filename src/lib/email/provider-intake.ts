import { getDb } from "@/db";
import { domains } from "@/db/schema";
import { normalizeEmailAddress } from "@/lib/email/address";
import { inboundAttachmentLimitReasonFromRaw } from "@/lib/email/inbound-attachments";
import { intakeIncomingMail } from "@/lib/email/intake";
import { readProviderHeaderMap } from "@/lib/email/provider-headers-utils";
import { MAX_PROVIDER_RECIPIENTS, providerRawKey, type ProviderDelivery } from "@/lib/email/provider-intake-utils";
import { createLogger } from "@/lib/logger.mjs";

const logger = createLogger("inbound");

export const MAX_PROVIDER_MESSAGE_BYTES = 25 * 1024 * 1024;

/**
 * Hands a message a mail provider delivered (SES, Resend) to the normal intake,
 * once per recipient on a domain Kite manages. `provider: "ses"` passes the SMTP envelope, while Resend's addresses may
 * come from headers the sender wrote: they count only on domains that receive through Resend, and at most
 * `MAX_PROVIDER_RECIPIENTS` of them. Mail for a domain that receives elsewhere is dropped and logged (the MX of a domain
 * just moved off Resend can still bring some). Routing rules and storage then
 * behave as for Cloudflare mail, but nothing can be forwarded: a forward rule
 * without a copy drops the message. A provider cannot refuse the message after
 * it has been accepted, so a reject or a size limit simply drops it. Throws on
 * infrastructure failure (and a parse error that is not a MIME limit) so the
 * provider retries.
 * `authenticationResults` is the provider's own verdict (SES builds one from its receipt), never
 * the message's Authentication-Results headers, which may be the sender's. Resend passes neither, so its header
 * map is read from the message without any header that claims a verification.
 * `delivery` names the provider's message: with it a repeat (a webhook retry, a second webhook for the same message)
 * reaches each recipient's mailbox once. Without it every call delivers again.
 */
export async function intakeProviderMail(
	env: CloudflareEnv,
	input: {
		provider: "resend" | "ses";
		from: string;
		recipients: string[];
		raw: ArrayBuffer;
		headers?: Record<string, string>;
		authenticationResults?: string | null;
		delivery?: ProviderDelivery | null;
	},
): Promise<{ delivered: number; dropped: string | null }> {
	if (input.raw.byteLength > MAX_PROVIDER_MESSAGE_BYTES)
		return { delivered: 0, dropped: "Message exceeds the 25 MiB receiving limit" };
	const limit = await inboundAttachmentLimitReasonFromRaw(input.raw);
	if (limit) return { delivered: 0, dropped: limit };

	// A provider that gives no header map (Resend) still gets the plain headers, read from the message.
	const headers = input.headers ?? readProviderHeaderMap(input.raw);
	const rows = await getDb(env)
		.select({ hostname: domains.hostname, receivingProvider: domains.receivingProvider })
		.from(domains);
	const receiving = new Map(rows.map((domain) => [domain.hostname, domain.receivingProvider]));
	const hostOf = (address: string) => address.slice(address.lastIndexOf("@") + 1);
	const known = [...new Set(input.recipients.map(normalizeEmailAddress).filter(Boolean))].filter((address) =>
		receiving.has(hostOf(address)),
	);
	const recipients = input.provider === "resend" ? known.filter((a) => receiving.get(hostOf(a)) === "resend") : known;
	const elsewhere = new Set(known.filter((address) => !recipients.includes(address)).map(hostOf));
	for (const domain of elsewhere) logger.warn("email.provider_recipient_dropped", { provider: input.provider, domain });
	const capped = input.provider === "resend" ? recipients.slice(0, MAX_PROVIDER_RECIPIENTS) : recipients;
	if (capped.length < recipients.length)
		logger.warn("email.provider_recipients_capped", { provider: input.provider, count: recipients.length });

	let delivered = 0;
	for (const recipient of capped) {
		const result = await intakeIncomingMail(
			env,
			{
				from: normalizeEmailAddress(input.from),
				to: recipient,
				raw: input.raw,
				headers,
				authenticationResults: input.authenticationResults ?? null,
				...(input.delivery ? { rawR2Key: await providerRawKey(input.delivery, recipient) } : {}),
			},
			{},
		);
		if (result.action === "store") delivered += 1;
	}
	return { delivered, dropped: null };
}

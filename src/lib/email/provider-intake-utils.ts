import { sha256Hex } from "@/lib/aws/sigv4";
import { getEmailAddressList } from "@/lib/email/address";
import type { ResendReceivedEmail } from "@/lib/email/resend-api-types";

/** The most recipients one Resend message is delivered to, the same as one SMTP transaction here. */
export const MAX_PROVIDER_RECIPIENTS = 50;

/** A provider's own message: its id, and the time it received it, which every repeat reports the same. */
export type ProviderDelivery = { id: string; receivedAt: number };

/**
 * The same object for the same message and recipient, however often the provider calls. The time keeps the key in the
 * sweeper's order (`dueRawObjects`); the hash keeps the address out of it.
 */
export async function providerRawKey(delivery: ProviderDelivery, recipient: string): Promise<string> {
	const id = await sha256Hex(`${delivery.id}\n${recipient}`);
	return `inbound/${delivery.receivedAt}-${id.slice(0, 32)}.eml`;
}

/**
 * Every address a Resend message may be for, `received_for` first. Resend does not say whether `to`, `cc` and `bcc` are
 * the envelope or the headers, so none of them is enough alone: a mailing list or a forward names someone else in To,
 * and a delivered message carries no Bcc header. `received_for` is the closest to the envelope, but it comes from
 * `Received` headers the sender can write too, and Resend describes it as the addresses a message was forwarded for, so
 * it can name an earlier hop. None of these proves the mail was sent to that address, so intake takes only addresses on
 * domains that receive through Resend: there a sender gains nothing it could not get by adding them to RCPT TO.
 */
export function resendRecipients(email: ResendReceivedEmail): string[] {
	return [...(email.received_for ?? []), ...(email.to ?? []), ...(email.cc ?? []), ...(email.bcc ?? [])].flatMap(
		(value) => getEmailAddressList(value),
	);
}

/** What makes a Resend message idempotent, or null when it has no usable time. */
export function resendDelivery(email: ResendReceivedEmail): ProviderDelivery | null {
	const receivedAt = Date.parse(email.created_at ?? "");
	return Number.isFinite(receivedAt) ? { id: email.id, receivedAt } : null;
}

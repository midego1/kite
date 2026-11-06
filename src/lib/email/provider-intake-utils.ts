import { sha256Hex } from "@/lib/aws/sigv4";
import { getEmailAddressList } from "@/lib/email/address";
import type { ResendReceivedEmail } from "@/lib/email/resend-api-types";

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
 * Every address a Resend message may be for. Resend does not say whether `to`, `cc` and `bcc` are the envelope or the
 * headers, so none of them is enough alone: a mailing list or a forward names someone else in To, and a delivered
 * message carries no Bcc header. `received_for`, from the `Received` headers, is the closest to the envelope, but
 * Resend describes it as the addresses a message was forwarded for and it can name an earlier hop instead, so it adds
 * to the others rather than replacing them: a stray copy is better than lost mail. Intake keeps the known domains, and
 * every address goes through routing like an envelope recipient, which gains a sender nothing RCPT TO would not.
 */
export function resendRecipients(email: ResendReceivedEmail): string[] {
	return [...(email.to ?? []), ...(email.cc ?? []), ...(email.bcc ?? []), ...(email.received_for ?? [])].flatMap(
		(value) => getEmailAddressList(value),
	);
}

/** What makes a Resend message idempotent, or null when it has no usable time. */
export function resendDelivery(email: ResendReceivedEmail): ProviderDelivery | null {
	const receivedAt = Date.parse(email.created_at ?? "");
	return Number.isFinite(receivedAt) ? { id: email.id, receivedAt } : null;
}

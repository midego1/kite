import { upsertContactFromAddress } from "@/lib/contacts/service";
import type { SendEmailInput } from "./send";

type SendOrigin = Pick<SendEmailInput, "headers" | "recordContacts">;

/**
 * Whether the user chose these recipients: not module mail (`recordContacts: false`, such as RSVPs and booking
 * notices) and not an automatic message, which a stranger can trigger. `Auto-Submitted: no` marks a message a
 * person sent (RFC 3834), so only another value counts as automatic.
 */
export function isUserChosenSend(input: SendOrigin): boolean {
	if (input.recordContacts === false) return false;
	const automatic = Object.entries(input.headers ?? {}).some(
		([name, value]) => name.toLowerCase() === "auto-submitted" && value.trim().toLowerCase() !== "no",
	);
	return !automatic;
}

/**
 * Saves a delivered message's recipients as outbound contacts, which Kite treats as people the user chose to
 * write to (the send review's familiar recipients, automatic reading's known contacts). Only after the provider
 * accepted the message, so a cancelled scheduled or undone send records nobody, and never for an auto-reply or
 * module mail (upstream Mailflare #225).
 */
export async function recordOutboundContacts(
	env: CloudflareEnv,
	input: SendOrigin & Pick<SendEmailInput, "userId">,
	recipients: string[],
) {
	if (!isUserChosenSend(input)) return;
	for (const address of recipients)
		await upsertContactFromAddress(env, { userId: input.userId, address, source: "outbound" });
}

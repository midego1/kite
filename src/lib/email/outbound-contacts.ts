import { upsertContactFromAddress } from "@/lib/contacts/service";
import type { SendEmailInput } from "./send";

/**
 * Saves a delivered message's recipients as outbound contacts, which Kite treats as people the user chose to
 * write to (the send review's familiar recipients, automatic reading's known contacts). Only after the provider
 * accepted the message, so a cancelled scheduled or undone send records nobody, and never for an auto-reply or
 * module mail, which a stranger can trigger (upstream Mailflare #225).
 */
export async function recordOutboundContacts(
	env: CloudflareEnv,
	input: Pick<SendEmailInput, "userId" | "headers" | "recordContacts">,
	recipients: string[],
) {
	const automatic = Object.keys(input.headers ?? {}).some((name) => name.toLowerCase() === "auto-submitted");
	if (input.recordContacts === false || automatic) return;
	for (const address of recipients)
		await upsertContactFromAddress(env, { userId: input.userId, address, source: "outbound" });
}

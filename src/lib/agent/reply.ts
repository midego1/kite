import { getDb } from "@/db";
import { getEmailAddressList, normalizeEmailAddress } from "@/lib/email/address";
import { parseRawMime } from "@/lib/email/parse";
import { getMailboxDomainAddresses } from "@/lib/mailboxes/domain-addresses";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import type { AgentToolContext } from "./types";
import type { messages } from "@/db/schema";

export async function getReplyRecipients(
	context: AgentToolContext,
	source: typeof messages.$inferSelect,
	replyAll: boolean,
) {
	let recipient = normalizeEmailAddress(context.replyTo ?? source.fromAddr);
	if (source.rawR2Key && !context.replyTo) {
		const object = await context.env.BUCKET.get(source.rawR2Key);
		if (object) {
			// The bounded parser: the stored raw message is whatever the sender wrote.
			const replyTo = getEmailAddressList((await parseRawMime(await object.arrayBuffer())).replyTo).at(0);
			if (replyTo) recipient = replyTo;
		}
	}
	if (!recipient.includes("@")) throw new Error("Source has no reply address");
	const access = await getMailboxAccessLevel(getDb(context.env), context.user, context.mailboxId);
	if (!access) throw new Error("Mailbox not found");
	const ownAddresses = new Set(await getMailboxDomainAddresses(getDb(context.env), access.mailbox));
	if (ownAddresses.has(recipient)) throw new Error("Cannot draft a reply to this mailbox");
	const cc = replyAll
		? [...new Set([...getEmailAddressList(source.toAddr), ...getEmailAddressList(source.ccAddr)])]
				.filter((address) => !ownAddresses.has(address) && address !== recipient)
				.join(", ")
		: "";
	return { to: recipient, cc };
}

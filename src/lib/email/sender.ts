import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { domains, mailboxes, users } from "@/db/schema";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { formatEmailAddress, getEmailAddress } from "@/lib/email/address";
import { getMailboxDomainAddresses } from "@/lib/mailboxes/domain-addresses";
import { resolveMailboxDisplayName } from "@/lib/profile/identity-utils";
import {
	CONNECTED_FROM_COMPOSER_ONLY,
	isOwnConnectedAddress,
	resolveSendIdentity,
} from "@/lib/external-accounts/identities";

export type AuthorizedSender = {
	fromAddr: string;
	mailboxId: string;
	/** Set when From is a connected account's address: the send goes through that account's SMTP server (spec §7.3). */
	externalAccountId: string | null;
	/** The connected account's provider limit on one message, encoding included. */
	sendLimit?: { bytes: number; provider: string } | null;
};

/**
 * The From a user may send with from a mailbox, formatted with its display name. Addresses of the mailbox's domains
 * work for everyone allowed to send from it; with `connectedAccounts` (the signed-in composer only: never API keys,
 * MCP, JMAP or automations, spec §9.3) the user's own connected addresses that deliver into the mailbox work too.
 */
export async function getAuthorizedSenderAddress(
	env: CloudflareEnv,
	input: {
		userId: string;
		from: string;
		mailboxId?: string | null;
		connectedAccounts?: boolean;
	},
): Promise<AuthorizedSender> {
	if (!input.mailboxId) throw new Error("Mailbox is required");

	const db = getDb(env);
	const [mailbox] = await db
		.select({
			localPart: mailboxes.localPart,
			displayName: mailboxes.displayName,
			type: mailboxes.type,
			ownerName: users.name,
			ownerEmail: users.email,
			hostname: domains.hostname,
			domainId: mailboxes.domainId,
			useAllDomains: mailboxes.useAllDomains,
			id: mailboxes.id,
		})
		.from(mailboxes)
		.innerJoin(domains, eq(mailboxes.domainId, domains.id))
		.innerJoin(users, eq(mailboxes.userId, users.id))
		.where(eq(mailboxes.id, input.mailboxId))
		.limit(1);

	if (!mailbox) throw new Error("Mailbox not found");
	const [actor] = await db.select().from(users).where(eq(users.id, input.userId)).limit(1);
	if (!actor || actor.disabled) throw new Error("Sender account not found");

	const access = await getMailboxAccessLevel(db, actor, mailbox.id);
	if (!access?.canSendOnBehalf) {
		throw new Error("You do not have permission to send from this mailbox");
	}

	const requestedAddress = getEmailAddress(input.from);
	const permittedAddresses = await getMailboxDomainAddresses(db, mailbox);
	if (!permittedAddresses.includes(requestedAddress.toLowerCase())) {
		if (!input.connectedAccounts) {
			// A draft from the composer may carry a connected From into approvals, the assistant or JMAP: say why not.
			if (await isOwnConnectedAddress(env, actor.id, requestedAddress)) throw new Error(CONNECTED_FROM_COMPOSER_ONLY);
			throw new Error("Sender address does not match the selected mailbox");
		}
		const identity = await resolveSendIdentity(env, {
			userId: actor.id,
			mailboxId: mailbox.id,
			address: requestedAddress,
		});
		if (!identity) throw new Error("Sender address does not match the selected mailbox");
		return {
			fromAddr: formatEmailAddress(identity.address, identity.displayName ?? actor.name),
			mailboxId: mailbox.id,
			externalAccountId: identity.accountId,
			sendLimit: identity.sendLimit,
		};
	}
	const senderAddress = requestedAddress.toLowerCase();
	// The primary mailbox sends under the account name; every other mailbox
	// sends under its own.
	const senderName = resolveMailboxDisplayName(mailbox, mailbox.ownerEmail, mailbox.ownerName);

	if (access.canSendAs) {
		return {
			fromAddr: formatEmailAddress(senderAddress, senderName),
			mailboxId: mailbox.id,
			externalAccountId: null,
		};
	}

	const mailboxName = senderName || senderAddress;
	return {
		fromAddr: formatEmailAddress(senderAddress, `${actor.name} on behalf of ${mailboxName}`),
		mailboxId: mailbox.id,
		externalAccountId: null,
	};
}

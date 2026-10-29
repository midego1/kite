import type { SendIdentity } from "@/lib/external-accounts/types";

type SenderMailbox = {
	localPart: string;
	hostname: string;
	senderAddresses?: string[];
	externalIdentities?: SendIdentity[];
};

/** A From choice: one of the mailbox's own addresses, or a connected account's address (`identity`). */
export type SenderOption<M> = { mailbox: M; address: string; identity: SendIdentity | null; disabled: boolean };

/** The mailbox's own addresses (its domains), or its primary address when the list is not loaded. @public Exercised by the unit tests. */
export function mailboxOwnAddresses(mailbox: SenderMailbox): string[] {
	return mailbox.senderAddresses?.length ? mailbox.senderAddresses : [`${mailbox.localPart}@${mailbox.hostname}`];
}

/**
 * Every address the user can send from in this mailbox: its own, then the user's connected addresses that deliver
 * into it and can send now (spec §7.3). Replies pick from these the address the message came to.
 */
export function mailboxSendableAddresses(mailbox: SenderMailbox): string[] {
	const own = mailboxOwnAddresses(mailbox);
	const connected = (mailbox.externalIdentities ?? [])
		.filter((identity) => identity.available && !own.includes(identity.address))
		.map((identity) => identity.address);
	return [...own, ...connected];
}

/** The From menu: each mailbox's own addresses, then its connected ones, unavailable ones listed but disabled. */
export function senderOptionsFor<M extends SenderMailbox>(mailboxes: readonly M[]): SenderOption<M>[] {
	return mailboxes.flatMap((mailbox) => {
		const own = mailboxOwnAddresses(mailbox);
		return [
			...own.map((address) => ({ mailbox, address, identity: null, disabled: false })),
			...(mailbox.externalIdentities ?? [])
				.filter((identity) => !own.includes(identity.address))
				.map((identity) => ({ mailbox, address: identity.address, identity, disabled: !identity.available })),
		];
	});
}

/** `me@gmail.com (via Gmail)`, or with what to do first: `me@gmail.com (Reconnect in Settings)`. */
export function senderOptionLabel(option: { address: string; identity: SendIdentity | null }): string {
	const { identity } = option;
	if (!identity) return option.address;
	if (identity.action === "reconnect") return `${option.address} (Reconnect in Settings)`;
	if (identity.action === "test_connection") return `${option.address} (Test the connection in Settings)`;
	return `${option.address} (via ${identity.presetLabel})`;
}

/** What the composer says after a send: scheduled, sent, or waiting because the provider asked to try later. */
export function sentToastMessage(result: { scheduled?: boolean; retrying?: boolean }): string {
	if (result.scheduled) return "Message scheduled";
	if (result.retrying) return "The provider asked Kite to try again shortly. The message waits in Sent until then.";
	return "Message sent";
}

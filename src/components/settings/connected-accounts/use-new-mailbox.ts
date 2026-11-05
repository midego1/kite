"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { canManageOwnMailboxes } from "@/app/(admin)/mailboxes/utils";
import type { MailboxOption } from "@/components/mailbox-provider";
import { useAuthMe } from "@/hooks/use-auth-me";
import {
	canOfferNewMailbox,
	createAccountMailbox,
	deleteAccountMailbox,
	fetchUsableDomains,
	mailboxLocalPartProblem,
	NEW_MAILBOX_VALUE,
	suggestMailboxLocalPart,
	type CreatedMailbox,
	type NewMailboxState,
} from "./new-mailbox-utils";

/**
 * The connect dialog's "New mailbox for this account": whether it is offered (only to people who may create mailboxes,
 * on a domain they may use), the name and domain being typed (the name suggested from the address until edited), and
 * the mailbox created by a submit whose connecting then failed (`created`), which stays so a retry reuses it.
 */
export function useNewMailbox(input: {
	editing: boolean;
	address: string;
	mailboxId: string;
	mailboxes: MailboxOption[];
}) {
	const { data: me } = useAuthMe();
	const [typed, setTyped] = useState<NewMailboxState>({ localPart: "", domainId: "", edited: false });
	const [created, setCreated] = useState<CreatedMailbox | null>(null);
	const { data: domains = [] } = useQuery({
		queryKey: ["connected-accounts", "usable-domains"],
		queryFn: fetchUsableDomains,
		enabled: !input.editing && canManageOwnMailboxes(me?.user),
		refetchOnWindowFocus: false,
	});
	// While a created mailbox is kept (connecting failed) a second one is never offered: it would be made and forgotten.
	const offered = !input.editing && !created && canOfferNewMailbox(me?.user, domains);
	const creating = offered && input.mailboxId === NEW_MAILBOX_VALUE;
	const domainId = domains.some((domain) => domain.id === typed.domainId) ? typed.domainId : (domains[0]?.id ?? "");
	const taken = new Set(input.mailboxes.filter((entry) => entry.domainId === domainId).map((entry) => entry.localPart));
	const localPart = typed.edited ? typed.localPart : suggestMailboxLocalPart(input.address, taken);
	const problem = creating ? mailboxLocalPartProblem(localPart, taken) : null;

	return {
		offered,
		creating,
		domains,
		domainId,
		localPart,
		problem,
		created,
		change: (change: Partial<NewMailboxState>) => setTyped({ localPart, domainId, edited: typed.edited, ...change }),
		/**
		 * Creates the mailbox when "New mailbox" is chosen; the one an earlier try made only while it is still the chosen
		 * mailbox, otherwise null (the person picked another). Throws when creating fails.
		 */
		async ensure(): Promise<CreatedMailbox | null> {
			if (!creating) return created && created.id === input.mailboxId ? created : null;
			const mailbox = await createAccountMailbox({ domainId, localPart });
			setCreated(mailbox);
			return mailbox;
		},
		clear: () => setCreated(null),
		async deleteCreated(): Promise<void> {
			if (created) await deleteAccountMailbox(created.id);
			setCreated(null);
		},
	};
}

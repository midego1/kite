"use client";

import { useCallback, useMemo, useState } from "react";
import { LAST_FROM_STORAGE_KEY } from "@/components/mailbox-provider-utils";
import { useSelectedMailbox, type MailboxOption } from "@/components/mailbox-provider";
import { useStoredState } from "@/hooks/use-stored-state";
import { canSendFromMailbox, pickComposeMailbox } from "@/lib/mailboxes/scope-utils";

type LastFrom = { mailboxId: string; address: string };

/**
 * The mailbox a composer sends from, among the mailboxes the user may send from (never a read-only
 * shared one). With one mailbox selected it is that mailbox, and choosing another From switches to it
 * as before. In All mailboxes the choice stays with the composer (the view keeps listing every
 * mailbox), a reply or forward keeps its draft's mailbox, and a new message starts from the From used
 * last while that is still allowed.
 */
export function useComposeMailbox() {
	const { selectedMailbox, setSelectedMailbox, mailboxes, allMailboxes } = useSelectedMailbox();
	const [lastFrom, setLastFrom] = useStoredState<LastFrom | null>(LAST_FROM_STORAGE_KEY, null);
	const [chosenId, setChosenId] = useState<string | null>(null);
	const sendable = useMemo(() => mailboxes.filter((mailbox) => canSendFromMailbox(mailbox.permission)), [mailboxes]);
	const chooseLocal = useCallback((mailbox: MailboxOption | null) => setChosenId(mailbox?.id ?? null), []);
	const rememberFrom = useCallback(
		(mailbox: MailboxOption | null, address: string) => {
			if (mailbox && address) setLastFrom({ mailboxId: mailbox.id, address });
		},
		[setLastFrom],
	);

	if (!allMailboxes) {
		const mailbox = pickComposeMailbox(sendable, [selectedMailbox?.id]);
		return { selectedMailbox: mailbox, setSelectedMailbox, mailboxes: sendable, defaultFrom: null, rememberFrom };
	}
	const mailbox = pickComposeMailbox(sendable, [chosenId, lastFrom?.mailboxId, selectedMailbox?.id]);
	return {
		selectedMailbox: mailbox,
		setSelectedMailbox: chooseLocal,
		mailboxes: sendable,
		defaultFrom: lastFrom && lastFrom.mailboxId === mailbox?.id ? lastFrom.address : null,
		rememberFrom,
	};
}

"use client";

import { useCallback, useState } from "react";
import { LAST_FROM_STORAGE_KEY } from "@/components/appearance-preferences";
import { useSelectedMailbox, type MailboxOption } from "@/components/mailbox-provider";
import { useStoredState } from "@/hooks/use-stored-state";

type LastFrom = { mailboxId: string; address: string };

/**
 * The mailbox a composer sends from. With one mailbox selected it is that mailbox, and choosing
 * another From switches to it as before. In All mailboxes the choice stays with the composer
 * (the view keeps listing every mailbox), a reply or forward keeps its draft's mailbox, and a new
 * message starts from the From used last.
 */
export function useComposeMailbox() {
	const { selectedMailbox, setSelectedMailbox, mailboxes, allMailboxes } = useSelectedMailbox();
	const [lastFrom, setLastFrom] = useStoredState<LastFrom | null>(LAST_FROM_STORAGE_KEY, null);
	const [chosenId, setChosenId] = useState<string | null>(null);
	const chooseLocal = useCallback((mailbox: MailboxOption | null) => setChosenId(mailbox?.id ?? null), []);
	const rememberFrom = useCallback((from: LastFrom) => setLastFrom(from), [setLastFrom]);

	if (!allMailboxes) {
		return { selectedMailbox, setSelectedMailbox, mailboxes, defaultFrom: null, rememberFrom };
	}
	const id = chosenId ?? lastFrom?.mailboxId;
	const mailbox = mailboxes.find((item) => item.id === id) ?? selectedMailbox;
	return {
		selectedMailbox: mailbox,
		setSelectedMailbox: chooseLocal,
		mailboxes,
		defaultFrom: lastFrom && lastFrom.mailboxId === mailbox?.id ? lastFrom.address : null,
		rememberFrom,
	};
}

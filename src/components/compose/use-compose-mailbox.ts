"use client";

import { useCallback, useMemo, useState } from "react";
import { LAST_FROM_STORAGE_KEY } from "@/components/mailbox-provider-utils";
import { useSelectedMailbox, type MailboxOption } from "@/components/mailbox-provider";
import { useStoredState } from "@/hooks/use-stored-state";
import { canSendFromMailbox, pickComposeMailbox } from "@/lib/mailboxes/scope-utils";

/** The first preferred address the mailbox can send from (this composer's choice, then the last From), else its first. */
export function pickFromAddress(addresses: readonly string[], preferred: ReadonlyArray<string | null>): string {
	return preferred.find((address) => !!address && addresses.includes(address)) ?? addresses[0] ?? "";
}

type LastFrom = { mailboxId: string; address: string };

/**
 * The mailbox a composer sends from, among the mailboxes the user may send from (never a read-only
 * shared one). It starts with the mailbox in view (in All mailboxes: the From used last while that is
 * still allowed) and is then the composer's own: switching mailbox in the sidebar, or the view going to
 * All mailboxes, never moves a message being written, a reply or a loaded draft. Only the From menu (and
 * a loaded draft's mailbox) changes it. A reply or forward keeps its draft's mailbox.
 */
export function useComposeMailbox() {
	const { selectedMailbox, mailboxes, allMailboxes } = useSelectedMailbox();
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

	const mailbox = allMailboxes
		? pickComposeMailbox(sendable, [chosenId, lastFrom?.mailboxId, selectedMailbox?.id])
		: pickComposeMailbox(sendable, [chosenId, selectedMailbox?.id]);
	// Once the composer has a mailbox it keeps it, whatever the view does afterwards.
	if (chosenId === null && mailbox && sendable.length > 0) setChosenId(mailbox.id);
	return {
		selectedMailbox: mailbox,
		setSelectedMailbox: chooseLocal,
		mailboxes: sendable,
		defaultFrom: allMailboxes && lastFrom && lastFrom.mailboxId === mailbox?.id ? lastFrom.address : null,
		rememberFrom,
	};
}

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
 * still allowed, address included) and is then the composer's own: switching mailbox in the sidebar, or the
 * view going to or leaving All mailboxes, never moves a message being written, a reply or a loaded draft, nor
 * changes the address it started with. Only the From menu (and a loaded draft's mailbox) changes it. A reply
 * or forward keeps its draft's mailbox.
 */
export function useComposeMailbox() {
	const { selectedMailbox, mailboxes, allMailboxes } = useSelectedMailbox();
	const [lastFrom, setLastFrom] = useStoredState<LastFrom | null>(LAST_FROM_STORAGE_KEY, null);
	// The mailbox the composer settled on, with the address it started from (only a new message in All mailboxes has one).
	const [choice, setChoice] = useState<{ id: string; startFrom: string | null } | null>(null);
	const sendable = useMemo(() => mailboxes.filter((mailbox) => canSendFromMailbox(mailbox.permission)), [mailboxes]);
	const chooseLocal = useCallback((mailbox: MailboxOption | null) => {
		setChoice(mailbox ? { id: mailbox.id, startFrom: null } : null);
	}, []);
	const rememberFrom = useCallback(
		(mailbox: MailboxOption | null, address: string) => {
			if (mailbox && address) setLastFrom({ mailboxId: mailbox.id, address });
		},
		[setLastFrom],
	);

	const mailbox = allMailboxes
		? pickComposeMailbox(sendable, [choice?.id, lastFrom?.mailboxId, selectedMailbox?.id])
		: pickComposeMailbox(sendable, [choice?.id, selectedMailbox?.id]);
	// Once the composer has a mailbox it keeps it, whatever the view does afterwards.
	if (choice === null && mailbox && sendable.length > 0) {
		const startFrom = allMailboxes && lastFrom?.mailboxId === mailbox.id ? lastFrom.address : null;
		setChoice({ id: mailbox.id, startFrom });
	}
	return {
		selectedMailbox: mailbox,
		setSelectedMailbox: chooseLocal,
		mailboxes: sendable,
		defaultFrom: choice?.id === mailbox?.id ? (choice?.startFrom ?? null) : null,
		rememberFrom,
	};
}

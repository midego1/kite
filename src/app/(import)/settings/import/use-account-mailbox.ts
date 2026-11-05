"use client";

import { useEffect, useRef } from "react";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import type { ImportSourceAccount } from "./types";

/**
 * An import from a connected account starts in the mailbox the account's mail goes to (the page's "mailbox selected in
 * the sidebar"). `intoAccountMailbox` selects it when the person picks an account; the account named in the link
 * (`?account=`) is followed once, as soon as the accounts and the mailboxes have loaded. A mailbox the person has no full
 * access to is never selected.
 */
export function useAccountMailbox(accountParam: string, accounts: ImportSourceAccount[], selectedId: string | null) {
	const { mailboxes, setSelectedMailbox } = useSelectedMailbox();
	const followed = useRef<string | null>(null);
	const select = (accountId: string): boolean => {
		const target = accounts.find((entry) => entry.id === accountId)?.mailboxId;
		const found = mailboxes.find((mailbox) => mailbox.id === target);
		if (!found) return false;
		if ((found.permission ?? "full_access") === "full_access" && found.id !== selectedId) setSelectedMailbox(found);
		return true;
	};
	useEffect(() => {
		if (!accountParam || followed.current === accountParam) return;
		if (select(accountParam)) followed.current = accountParam;
		// eslint-disable-next-line react-hooks/exhaustive-deps -- `select` is rebuilt every render from these.
	}, [accountParam, accounts, mailboxes, selectedId]);
	return { mailboxes, intoAccountMailbox: (accountId: string) => void select(accountId) };
}

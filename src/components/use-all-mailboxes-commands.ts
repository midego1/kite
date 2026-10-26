"use client";

import { useEffect } from "react";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { useShortcuts } from "@/components/shortcuts";

/** Offers the palette the way into All mailboxes, or back to one mailbox, whichever applies. */
export function useAllMailboxesCommands() {
	const { registerCommandHandler } = useShortcuts();
	const { mailboxes, allMailboxes, setAllMailboxes } = useSelectedMailbox();
	const offered = mailboxes.length < 2 ? null : allMailboxes ? "one-mailbox" : "all-mailboxes";

	useEffect(() => {
		if (!offered) return;
		return registerCommandHandler(offered, ({ navigate }) => {
			setAllMailboxes(offered === "all-mailboxes");
			navigate("/inbox");
		});
	}, [offered, registerCommandHandler, setAllMailboxes]);
}

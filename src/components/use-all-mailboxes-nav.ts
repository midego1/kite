"use client";

import { useEffect, useState } from "react";
import { useSelectedMailbox, type MailboxOption } from "@/components/mailbox-provider";
import { useShortcuts } from "@/components/shortcuts";

/** Offers the palette the way into All mailboxes, or back to one mailbox, whichever applies. */
function useAllMailboxesCommands() {
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

export type FolderTarget = {
	/** The mailbox a new folder is created in. */
	mailboxId: string | undefined;
	/** In All mailboxes, the user's own mailboxes to choose from; empty with one mailbox selected. */
	choices: MailboxOption[];
	choose: (mailboxId: string) => void;
	description: string;
};

/**
 * What the sidebar needs to know about the All mailboxes view: the mailbox whose Screener setting
 * decides whether the Screener is listed (any listed mailbox that holds new senders back), and where
 * a new folder goes (the selected mailbox, or one the user picks among those they fully manage).
 */
export function useAllMailboxesNav() {
	useAllMailboxesCommands();
	const { selectedMailbox, allMailboxes, viewMailboxes } = useSelectedMailbox();
	const [chosen, choose] = useState<string | null>(null);
	if (!allMailboxes) {
		const folderTarget: FolderTarget = {
			mailboxId: selectedMailbox?.id,
			choices: [],
			choose,
			description: "Add a folder to the selected mailbox.",
		};
		return { screenerMailbox: selectedMailbox, folderTarget };
	}
	const choices = viewMailboxes.filter((mailbox) => (mailbox.permission ?? "full_access") === "full_access");
	const target =
		choices.find((mailbox) => mailbox.id === chosen) ??
		choices.find((mailbox) => mailbox.id === selectedMailbox?.id) ??
		choices[0];
	const folderTarget: FolderTarget = {
		mailboxId: target?.id,
		choices,
		choose,
		description: "Add a folder to one of your mailboxes.",
	};
	const screenerMailbox =
		viewMailboxes.find((mailbox) => mailbox.screener?.enabled && mailbox.screener.mode === "screener") ?? null;
	return { screenerMailbox, folderTarget };
}

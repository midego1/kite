import { UserCheck } from "lucide-react";
import type { MessageCounts } from "@/hooks/types";
import type { MailboxOption } from "@/components/mailbox-provider";
import type { NavLink } from "@/components/components-nav-types";

const SCREENER_HREF = "/screener";

/**
 * The Screener sidebar item with the number of held messages. Like "For you" it always takes part in the
 * reorderable layout and is filtered out of view unless the mailbox holds new senders back or still has
 * held mail (for example right after the Screener was switched to Inbox mode).
 */
export function useScreenerNav(mailbox: MailboxOption | null | undefined, folders: MessageCounts["folders"]) {
	const held = folders.screener?.total ?? 0;
	const visible = (mailbox?.screener?.enabled === true && mailbox.screener.mode === "screener") || held > 0;
	const link: NavLink = { href: SCREENER_HREF, label: "Screener", icon: UserCheck, count: held || undefined };
	return {
		withLink(links: NavLink[]): NavLink[] {
			const inbox = links.findIndex((item) => item.href === "/inbox");
			return [...links.slice(0, inbox + 1), link, ...links.slice(inbox + 1)];
		},
		visibleIds(ordered: string[]): string[] {
			return visible ? ordered : ordered.filter((id) => id !== SCREENER_HREF);
		},
	};
}

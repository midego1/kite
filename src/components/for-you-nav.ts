import { Sparkles } from "lucide-react";
import { useOpenSuggestions } from "@/hooks/use-open-suggestions";
import { forYouVisible } from "@/lib/agent/auto-read/for-you-utils";
import type { NavLink } from "./components-nav-types";

const FOR_YOU_HREF = "/for-you";

/**
 * The "For you" sidebar item with its open-suggestion count. It always takes part in the reorderable
 * layout (so a saved order keeps its place below Inbox) and is only filtered out of view while every
 * full-access mailbox has automatic reading off.
 */
export function useForYouNav() {
	const { loaded, suggestions, mailboxes } = useOpenSuggestions();
	const visible = loaded && forYouVisible(mailboxes);
	const link: NavLink = { href: FOR_YOU_HREF, label: "For you", icon: Sparkles, count: suggestions.length };
	return {
		withLink(links: NavLink[]): NavLink[] {
			const inbox = links.findIndex((item) => item.href === "/inbox");
			return [...links.slice(0, inbox + 1), link, ...links.slice(inbox + 1)];
		},
		visibleIds(ordered: string[]): string[] {
			return visible ? ordered : ordered.filter((id) => id !== FOR_YOU_HREF);
		},
	};
}

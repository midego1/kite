"use client";

import { usePathname } from "next/navigation";
import { SquarePen } from "lucide-react";
import { useT } from "@/lib/i18n/use-t";
import { useCompose } from "./compose/compose-context";
import { useListBesideReader } from "./messages/list-beside-reader";
import { hidesMobileTabBar, isMailPath, isMessageDetailPath } from "./mobile-tab-bar-utils";

/**
 * The phone's "New mail": Compose otherwise sits inside the sidebar sheet, two taps away (More, then Compose),
 * which is the one primary mail action with no direct tab. A floating button over the mail screens matches
 * where the tab bar already shows and hides (`hidesMobileTabBar`), and sits above it with the same safe-area
 * clearance as the Drive upload panel. Only over mail routes: Calendar, Drive and Money Watch have their own
 * primary action and compose would be the wrong one there. Unlike the tab bar, this also drops out for an open
 * message even with the list kept beside the reader (an unfolded or iPad-sized phone shell): the reader's own
 * reply bar sits in that same bottom-end corner, and the message already offers Reply, Reply all and Forward.
 */
export function MobileComposeFab() {
	const t = useT();
	const pathname = usePathname();
	const { open: composerOpen, placement: composerPlacement, openComposer } = useCompose();
	const listBesideReader = useListBesideReader();

	if (!isMailPath(pathname)) return null;
	if (hidesMobileTabBar(pathname, listBesideReader)) return null;
	if (isMessageDetailPath(pathname)) return null;
	if (composerOpen && composerPlacement === "popup") return null;

	return (
		<button
			type="button"
			data-mobile-compose-fab=""
			onClick={() => openComposer()}
			aria-label={t("Compose new email")}
			className="fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom))] end-4 z-[80] flex h-14 w-14 items-center justify-center rounded-full bg-blue-600 text-white shadow-lg transition-colors hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 md:hidden"
		>
			<SquarePen className="h-6 w-6" aria-hidden="true" />
		</button>
	);
}

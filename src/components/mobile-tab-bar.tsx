"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
	CalendarDays,
	FileText,
	HardDrive,
	Inbox,
	Menu,
	Send,
	Sparkles,
	Star,
	WalletCards,
	type LucideIcon,
} from "lucide-react";
import { msg } from "@/lib/i18n/translator";
import { useT } from "@/lib/i18n/use-t";
import { cn } from "@/lib/utils";
import { useMessageCounts } from "@/hooks/use-message-counts";
import { useOpenSuggestions } from "@/hooks/use-open-suggestions";
import { useCompose } from "./compose/compose-context";
import { useListBesideReader } from "./messages/list-beside-reader";
import { useSelectedMailbox } from "./mailbox-provider";
import { useModules } from "./modules/modules-context";
import { useSidebar } from "./sidebar-state";
import { hidesMobileTabBar, mobileActiveTabId, mobilePrimaryTabIds, type MobileTabId } from "./mobile-tab-bar-utils";

/** `name` is the accessible name where the label is shortened to fit a 320 px tab ("Money Watch" would be cut off). */
type TabMeta = { label: string; name?: string; icon: LucideIcon; href?: string };

const TAB_META: Record<MobileTabId, TabMeta> = {
	mail: { label: msg("Mail"), icon: Inbox, href: "/inbox" },
	"for-you": { label: msg("For you"), icon: Sparkles, href: "/for-you" },
	calendar: { label: msg("Calendar"), icon: CalendarDays, href: "/calendar" },
	drive: { label: "Drive", icon: HardDrive, href: "/drive" },
	finance: { label: "Money", name: "Money Watch", icon: WalletCards, href: "/finance" },
	starred: { label: msg("Starred"), icon: Star, href: "/starred" },
	sent: { label: msg("Sent"), icon: Send, href: "/sent" },
	drafts: { label: msg("Drafts"), icon: FileText, href: "/drafts" },
	more: { label: msg("More"), icon: Menu },
};

/**
 * The phone's primary navigation, as a tab bar under the page: Mail, the modules that are on (Calendar,
 * Drive, Money), and More, which opens the full mail menu. A folder's open message and the Compose page
 * hide it, because they keep their own Back button and need the room (unless an unfolded screen still shows the list beside the reader). From `md` up the sidebar takes over.
 */
export function MobileTabBar() {
	const t = useT();
	const pathname = usePathname();
	const { mobile, mobileOpen, toggle } = useSidebar();
	const { modules } = useModules();
	const { mailboxScope } = useSelectedMailbox();
	const { counts } = useMessageCounts(mailboxScope, mobile);
	const { loaded: suggestionsLoaded, total: suggestions } = useOpenSuggestions();
	const { open: composerOpen, placement: composerPlacement } = useCompose();
	const listBesideReader = useListBesideReader();

	if (hidesMobileTabBar(pathname, listBesideReader)) return null;
	// The floating composer opens without a route change and would cover the bar, so the bar steps aside.
	if (composerOpen && composerPlacement === "popup") return null;

	const tabs = mobilePrimaryTabIds(modules, suggestionsLoaded && suggestions > 0);
	const active = mobileActiveTabId(tabs, pathname);
	const unread = counts.folders.inbox.unread;

	return (
		<nav
			aria-label={t("Primary")}
			className="shrink-0 border-t border-neutral-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md md:hidden"
		>
			<div className="mx-auto flex h-[3.75rem] w-full max-w-lg items-stretch gap-0.5 px-1">
				{[...tabs, "more" as const].map((id) => {
					const meta = TAB_META[id];
					const Icon = meta.icon;
					const current = id === active;
					const badge = id === "mail" ? unread : id === "for-you" ? suggestions : 0;
					const className = cn(
						"relative flex min-w-0 flex-1 select-none flex-col items-center justify-center gap-[3px] rounded-lg px-1 text-[11px] font-medium leading-none outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500",
						current ? "text-blue-600" : "text-neutral-500 hover:text-neutral-900",
					);
					const content = (
						<>
							{current && (
								<span
									aria-hidden="true"
									className="absolute left-1/2 top-0 h-0.5 w-7 -translate-x-1/2 rounded-full bg-blue-500"
								/>
							)}
							<span className="relative flex h-[22px] w-[22px] items-center justify-center">
								<Icon aria-hidden="true" className="h-[21px] w-[21px]" strokeWidth={current ? 2.1 : 1.8} />
								{badge > 0 && (
									<span
										aria-hidden="true"
										className="pointer-events-none absolute -end-2.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-blue-600 px-1 text-[10px] font-semibold leading-none tabular-nums text-white ring-2 ring-white"
									>
										{badge > 99 ? "99+" : badge}
									</span>
								)}
							</span>
							<span className="max-w-full truncate">{t(meta.label)}</span>
							{badge > 0 && (
								<span className="sr-only">
									, {badge} {id === "for-you" ? "open suggestions" : "unread"}
								</span>
							)}
						</>
					);

					if (id === "more") {
						return (
							<button
								key={id}
								type="button"
								onClick={toggle}
								aria-label={t("More navigation")}
								aria-haspopup="dialog"
								aria-expanded={mobileOpen}
								className={className}
							>
								{content}
							</button>
						);
					}

					return (
						<Link
							key={id}
							href={meta.href!}
							aria-label={meta.name}
							aria-current={current ? "page" : undefined}
							className={className}
						>
							{content}
						</Link>
					);
				})}
			</div>
		</nav>
	);
}

"use client";

import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { CalendarDays, PanelLeft } from "lucide-react";
import { useModules } from "@/components/modules/modules-context";
import { SectionNavSheet } from "@/components/section-nav-sheet";
import { SECTION_PANEL_CLASS } from "@/components/settings/section-nav-utils";
import { useIsMobile } from "@/components/sidebar-mobile-utils";
import { PANEL_HEADER_CLASS } from "@/components/ui/page-utils";
import { SegmentedLinks } from "@/components/ui/segmented-control";
import { Tooltip } from "@/components/ui/tooltip";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useStoredState } from "@/hooks/use-stored-state";
import { CLIENT_MODULES } from "@/lib/modules/client-data";
import { moduleNavItems } from "@/lib/modules/nav-utils";
import { cn } from "@/lib/utils";
import { UpcomingSidebar } from "./upcoming-sidebar";
import type { UpcomingSidebarProps } from "./upcoming-sidebar-types";

/** Whether the upcoming events start open; below this width the week grid needs the room. */
const UPCOMING_OPEN_QUERY = "(min-width: 1536px)";
const UPCOMING_OPEN_KEY = "kite:calendar:upcoming-open";

/** Bookings | Calendar, the `module-tabs` items of the modules that are on, as the Settings menu switches modes. */
function CalendarSectionTabs() {
	const pathname = usePathname();
	const { modules } = useModules();
	const tabs = moduleNavItems(CLIENT_MODULES, "module-tabs", modules);
	return (
		<SegmentedLinks
			label="Calendar sections"
			landmark
			current={pathname}
			items={tabs.map((tab) => ({ key: tab.id, href: tab.href, label: tab.label }))}
			className="shrink-0"
		/>
	);
}

/**
 * The Calendar and Booking pages' two panels, drawn like the Settings menu beside its page: at the left the
 * upcoming events (a bottom sheet behind an "Upcoming" button in the header on phones, so nothing floats over the
 * grid; from `md` a column that folds to a rail,
 * open by default only on a wide window, remembered once toggled), at the right the page in its own bordered
 * panel, with the Bookings | Calendar tabs and the page's own controls in its header. The shell's `main` steps
 * back for `data-page-panels`.
 */
export function CalendarPanels({
	header,
	children,
	...upcoming
}: UpcomingSidebarProps & { header?: ReactNode; children: ReactNode }) {
	const mobile = useIsMobile();
	const wide = useMediaQuery(UPCOMING_OPEN_QUERY);
	const [stored, setStored] = useStoredState<boolean | null>(UPCOMING_OPEN_KEY, null);
	const [sheetOpen, setSheetOpen] = useState(false);
	const open = mobile || (stored ?? wide);
	return (
		<div data-page-panels className="flex h-full min-h-0 flex-col bg-inherit md:flex-row md:gap-2">
			<SectionNavSheet
				title="Upcoming events"
				label="Upcoming"
				open={sheetOpen}
				onOpenChange={setSheetOpen}
				// A flex column at every width, so on phones the list scrolls inside the sheet (its day headings stick and
				// the next batch loads on scroll), not the sheet around it.
				className={cn("flex min-h-0 w-full shrink-0 flex-col", SECTION_PANEL_CLASS, open ? "md:w-64" : "md:w-12")}
			>
				<div
					className={cn("flex h-14 shrink-0 items-center gap-2 border-b border-neutral-200", open ? "px-4" : "px-2")}
				>
					{open && <h2 className="min-w-0 flex-1 truncate text-base font-medium text-neutral-900">Upcoming</h2>}
					<Tooltip
						label={open ? "Hide upcoming events" : "Show upcoming events"}
						placement={open ? undefined : "right"}
					>
						<button
							type="button"
							onClick={() => setStored(!open)}
							aria-expanded={open}
							aria-label={open ? "Hide upcoming events" : "Show upcoming events"}
							className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-neutral-500 outline-none hover:bg-neutral-100 hover:text-neutral-900 focus-visible:ring-2 focus-visible:ring-blue-500 max-md:hidden pointer-coarse:h-11 pointer-coarse:w-11"
						>
							<PanelLeft className="h-4 w-4 rtl:-scale-x-100" aria-hidden="true" />
						</button>
					</Tooltip>
				</div>
				{open && <UpcomingSidebar {...upcoming} />}
			</SectionNavSheet>
			<section className={cn("flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-white", SECTION_PANEL_CLASS)}>
				<div className={cn(PANEL_HEADER_CLASS, "gap-3 max-md:h-auto max-md:flex-wrap max-md:py-2")}>
					<CalendarSectionTabs />
					<Tooltip label="Upcoming events" className="md:hidden">
						<button
							type="button"
							onClick={() => setSheetOpen(true)}
							aria-haspopup="dialog"
							aria-expanded={sheetOpen}
							aria-label="Upcoming events"
							className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-neutral-500 outline-none hover:bg-neutral-100 hover:text-neutral-900 focus-visible:ring-2 focus-visible:ring-blue-500 md:hidden pointer-coarse:h-11 pointer-coarse:w-11"
						>
							<CalendarDays className="h-4 w-4" aria-hidden="true" />
						</button>
					</Tooltip>
					{header}
				</div>
				{children}
			</section>
		</div>
	);
}

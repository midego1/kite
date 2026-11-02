"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useModules } from "@/components/modules/modules-context";
import { SectionNavSheet } from "@/components/section-nav-sheet";
import { SECTION_PANEL_CLASS } from "@/components/settings/section-nav-utils";
import { SegmentedLinks } from "@/components/ui/segmented-control";
import { CLIENT_MODULES } from "@/lib/modules/client-data";
import { moduleNavItems } from "@/lib/modules/nav-utils";
import { cn } from "@/lib/utils";
import { UpcomingSidebar } from "./upcoming-sidebar";
import type { UpcomingSidebarProps } from "./upcoming-sidebar-types";

/** Bookings | Calendar, the `module-tabs` items of the modules that are on, as the Settings menu switches modes. */
function CalendarSectionTabs() {
	const pathname = usePathname();
	const { modules } = useModules();
	const tabs = moduleNavItems(CLIENT_MODULES, "module-tabs", modules);
	return (
		<SegmentedLinks
			label="Calendar sections"
			current={pathname}
			items={tabs.map((tab) => ({ key: tab.id, href: tab.href, label: tab.label }))}
			className="flex-1"
		/>
	);
}

/**
 * The Calendar and Booking pages' two panels, drawn like the Settings menu beside its page: at the left the
 * section tabs over the upcoming events (a bottom sheet behind an "Upcoming" pill on phones), at the right the
 * page itself in its own bordered panel. The shell's `main` steps back for `data-page-panels`.
 */
export function CalendarPanels({ children, ...upcoming }: UpcomingSidebarProps & { children: ReactNode }) {
	return (
		<div data-page-panels className="flex h-full min-h-0 flex-col bg-inherit md:flex-row md:gap-2">
			<SectionNavSheet
				title="Upcoming events"
				label="Upcoming"
				className={cn("w-full md:flex md:min-h-0 md:w-64 md:shrink-0 md:flex-col", SECTION_PANEL_CLASS)}
			>
				<div className="flex h-14 shrink-0 items-center border-b border-neutral-200 px-3">
					<CalendarSectionTabs />
				</div>
				<UpcomingSidebar {...upcoming} />
			</SectionNavSheet>
			<section className={cn("flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-white", SECTION_PANEL_CLASS)}>
				{children}
			</section>
		</div>
	);
}

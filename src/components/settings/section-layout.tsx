"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { LifeBuoy } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { SOURCE_CODE_URL } from "@/lib/source-code";
import type { NavMode } from "./section-nav-types";
import { SectionNav } from "./section-nav";
import { SECTION_PANEL_CLASS, findActiveNavItem, findActiveNavSection, navModeLabels } from "./section-nav-utils";

/** Where the page sits in the menu, as the page panel's top bar shows it: `Settings / Personal / Inbox`. */
function SectionTrail({ mode }: { mode: NavMode }) {
	const pathname = usePathname();
	const item = findActiveNavItem(mode, pathname);
	const section = findActiveNavSection(mode, pathname)?.label;
	const trail = [navModeLabels[mode], section, item?.label].filter(Boolean);
	return (
		// The page's own heading names it for assistive technology; the trail repeats it for sighted readers only.
		<p aria-hidden="true" className="flex min-w-0 items-center gap-1.5 truncate text-sm">
			{trail.map((part, index) => (
				<span
					key={`${index}-${part}`}
					className={index === trail.length - 1 ? "truncate font-medium text-neutral-900" : "text-neutral-500"}
				>
					{index > 0 && <span className="mr-1.5 text-neutral-300">/</span>}
					{part}
				</span>
			))}
		</p>
	);
}

/** The section menu beside the page content, shared by the Settings and Admin pages. */
export function SectionLayout({ mode, children }: { mode: NavMode; children: ReactNode }) {
	return (
		<div data-page-panels className="flex flex-col bg-inherit md:h-full md:flex-row md:gap-2">
			<SectionNav mode={mode} />
			<div className={`flex min-w-0 flex-1 flex-col md:min-h-0 ${SECTION_PANEL_CLASS}`}>
				<div className="hidden h-14 shrink-0 items-center gap-2 border-b border-neutral-200 px-4 md:flex">
					<SectionTrail mode={mode} />
					<span className="flex-1" />
					<Tooltip label="Need a hand?">
						<a
							href={`${SOURCE_CODE_URL}/issues`}
							target="_blank"
							rel="noreferrer"
							aria-label="Need a hand?"
							className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-500 outline-none hover:bg-neutral-100 hover:text-neutral-900 focus-visible:ring-2 focus-visible:ring-blue-500"
						>
							<LifeBuoy className="h-4 w-4" />
						</a>
					</Tooltip>
				</div>
				<div className="min-w-0 flex-1 pt-4 max-md:px-4 max-md:pb-36 md:overflow-y-auto md:overscroll-contain md:px-8 md:pt-6 md:pb-12 md:[scrollbar-gutter:stable]">
					<div className="mx-auto w-full max-w-3xl">{children}</div>
				</div>
			</div>
		</div>
	);
}

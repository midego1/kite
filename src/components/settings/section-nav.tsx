"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { ArrowLeft, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { useModules } from "@/components/modules/modules-context";
import { useCurrentUser } from "@/hooks/use-current-user";
import type { AuthMeUser } from "@/lib/auth/me-client-types";
import { PageSearchInput } from "@/components/mail-search/page-search-input";
import { Tooltip } from "@/components/ui/tooltip";
import { SectionNavSheet } from "../section-nav-sheet";
import type { NavMode, NavSearchGroup, NavSection } from "./section-nav-types";
import {
	SECTION_PANEL_CLASS,
	canShowModeSwitch,
	filterNavSections,
	findActiveNavItem,
	getNavMode,
	isActiveNavPath,
	navModeHome,
	navModeLabels,
	navSectionLabel,
	navSectionsFor,
	searchNavAcrossModes,
	switchTarget,
} from "./section-nav-utils";

const focusRing = "outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1";
const modes: NavMode[] = ["settings", "admin"];

/** Settings or Admin, as a segmented control under the search field, like the list panel's chips. */
function ModeSwitch({ mode, user }: { mode: NavMode; user: AuthMeUser | null }) {
	return (
		<div
			role="group"
			aria-label="Settings or admin"
			className="grid grid-cols-2 gap-1 rounded-lg border border-neutral-200 bg-[#f6f8fc] p-0.5"
		>
			{modes.map((option) => {
				const selected = option === mode;
				return (
					<Link
						key={option}
						href={selected ? navModeHome(option, user) : switchTarget(mode, user)}
						aria-current={selected ? "page" : undefined}
						className={cn(
							"rounded-md px-3 py-1 text-center text-sm transition-colors",
							focusRing,
							selected
								? "bg-white font-medium text-neutral-900 shadow-xs ring-1 ring-neutral-200"
								: "text-neutral-500 hover:text-neutral-900",
						)}
					>
						{navModeLabels[option]}
					</Link>
				);
			})}
		</div>
	);
}

function NavGroup({
	mode,
	section,
	pathname,
	withMode,
}: {
	mode: NavMode;
	section: NavSection;
	pathname: string;
	withMode: boolean;
}) {
	return (
		<div>
			{section.label && (
				// A muted label over the group, like the mail sidebar's "Core".
				<h2 className="flex h-7 items-center px-3 text-xs font-medium text-neutral-500">{section.label}</h2>
			)}
			<nav aria-label={navSectionLabel(mode, section, withMode)} className="space-y-px">
				{section.items.map((item) => {
					const active = isActiveNavPath(pathname, item.href);
					const Icon = item.icon;
					return (
						<Link
							key={item.href}
							href={item.href}
							aria-current={active ? "page" : undefined}
							className={cn(
								"flex h-9 items-center gap-3 rounded-lg px-3 text-sm transition-colors max-md:min-h-11 max-md:text-base",
								focusRing,
								active
									? "bg-blue-100 font-medium text-blue-900"
									: "text-neutral-700 hover:bg-neutral-100 hover:text-neutral-900",
							)}
						>
							<Icon className={cn("h-4 w-4 shrink-0", active ? "text-neutral-900" : "text-neutral-500")} />
							{item.label}
						</Link>
					);
				})}
			</nav>
		</div>
	);
}

function NavResults({ groups, mode, pathname }: { groups: NavSearchGroup[]; mode: NavMode; pathname: string }) {
	return groups.map((group) => {
		const withMode = group.mode !== mode;
		return (
			<div key={group.mode} className="flex flex-col gap-3">
				{withMode && (
					<p className="-mb-2 border-t border-neutral-200 px-3 pt-3 text-xs font-medium text-neutral-500">
						In {navModeLabels[group.mode]}
					</p>
				)}
				{group.sections.map((section) => (
					<NavGroup
						key={section.label || section.ariaLabel}
						mode={group.mode}
						section={section}
						pathname={pathname}
						withMode={withMode}
					/>
				))}
			</div>
		);
	});
}

/** The Settings and Admin side menu; `mode` defaults to the one the current route belongs to. */
export function SectionNav({ mode: modeProp }: { mode?: NavMode }) {
	const pathname = usePathname();
	const user = useCurrentUser();
	const { modules } = useModules();
	const [query, setQuery] = useState("");
	const mode = modeProp ?? getNavMode(pathname);
	const title = navModeLabels[mode];
	const groups: NavSearchGroup[] = query.trim()
		? searchNavAcrossModes(query, user, mode, modules)
		: [{ mode, sections: filterNavSections(navSectionsFor(mode), "", user, modules) }];

	return (
		<SectionNavSheet
			title={`${title} menu`}
			label={findActiveNavItem(mode, pathname)?.label ?? title}
			className={`w-full md:flex md:min-h-0 md:w-64 md:shrink-0 md:flex-col ${SECTION_PANEL_CLASS}`}
		>
			<div className="flex h-14 shrink-0 items-center gap-1 border-b border-neutral-200 px-2">
				<Tooltip label="Back to inbox">
					<Link
						href="/inbox"
						aria-label="Back to inbox"
						className={cn(
							"flex h-8 w-8 items-center justify-center rounded-lg text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900",
							focusRing,
						)}
					>
						<ArrowLeft className="h-4 w-4" />
					</Link>
				</Tooltip>
				<h2 className="min-w-0 truncate text-base font-medium text-neutral-900">{title}</h2>
			</div>
			<div className="flex shrink-0 flex-col gap-2 px-3 pt-3">
				<PageSearchInput />
				<label className="flex h-9 md:hidden items-center gap-2 rounded-lg border border-neutral-200 bg-[#f6f8fc] px-3 text-sm text-neutral-500 focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-500/20">
					<Search className="h-4 w-4 shrink-0" />
					<input
						type="search"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder={`Search ${title.toLowerCase()}`}
						aria-label={`Search ${title.toLowerCase()}`}
						className="min-w-0 flex-1 bg-transparent text-neutral-900 outline-none! border-none! shadow-none! p-0 placeholder:text-neutral-500"
					/>
				</label>
				{canShowModeSwitch(user) && <ModeSwitch mode={mode} user={user} />}
			</div>
			<div className="flex flex-col gap-3 px-2 pt-3 pb-4 md:min-h-0 md:flex-1 md:overflow-y-auto md:overscroll-contain">
				{groups.length === 0 && <p className="px-3 text-sm text-neutral-500">No pages match “{query.trim()}”.</p>}
				<NavResults groups={groups} mode={mode} pathname={pathname} />
			</div>
		</SectionNavSheet>
	);
}

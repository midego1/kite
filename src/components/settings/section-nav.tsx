"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { ChevronLeft, LifeBuoy, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCurrentUser } from "@/hooks/use-current-user";
import type { AuthMeUser } from "@/lib/auth/me-client-types";
import { SOURCE_CODE_URL } from "@/lib/source-code";
import { SectionNavSheet } from "../section-nav-sheet";
import type { NavMode, NavSearchGroup, NavSection } from "./section-nav-types";
import {
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

function ModeSwitch({ mode, user }: { mode: NavMode; user: AuthMeUser | null }) {
	return (
		<div role="group" aria-label="Settings or admin" className="grid grid-cols-2 gap-1 rounded-lg bg-neutral-100 p-1">
			{modes.map((option) => {
				const selected = option === mode;
				return (
					<Link
						key={option}
						href={selected ? navModeHome(option, user) : switchTarget(mode, user)}
						aria-current={selected ? "page" : undefined}
						className={cn(
							"rounded-md px-3 py-1.5 text-center text-sm font-medium transition-colors",
							focusRing,
							selected
								? "bg-white text-blue-900 shadow-sm ring-1 ring-blue-200"
								: "text-neutral-600 hover:bg-white/60 hover:text-neutral-900",
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
		<div className="space-y-1.5">
			{section.label && (
				<h2 className="px-3 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">{section.label}</h2>
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
								"flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
								focusRing,
								active ? "bg-blue-100 text-blue-900" : "text-neutral-700 hover:bg-neutral-100 hover:text-neutral-900",
							)}
						>
							<Icon className={cn("h-4 w-4 shrink-0", active ? "text-blue-700" : "text-neutral-500")} />
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
			<div key={group.mode} className="flex flex-col gap-5">
				{withMode && (
					<p className="-mb-3 border-t border-neutral-200/70 px-3 pt-4 text-xs font-semibold text-blue-700">
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
	const [query, setQuery] = useState("");
	const mode = modeProp ?? getNavMode(pathname);
	const title = navModeLabels[mode];
	const groups: NavSearchGroup[] = query.trim()
		? searchNavAcrossModes(query, user, mode)
		: [{ mode, sections: filterNavSections(navSectionsFor(mode), "", user) }];

	return (
		<SectionNavSheet
			title={`${title} menu`}
			label={findActiveNavItem(mode, pathname)?.label ?? title}
			className="w-full px-4 py-4 md:min-h-full md:w-64 md:shrink-0 md:border-r md:border-neutral-200/70 md:py-6"
		>
			<div className="sticky top-6 flex flex-col gap-5">
				<div className="space-y-3 px-2">
					<Link
						href="/inbox"
						className={cn(
							"flex w-fit items-center gap-1.5 rounded-md text-sm font-medium text-neutral-600 hover:text-neutral-900",
							focusRing,
						)}
					>
						<ChevronLeft className="h-4 w-4" />
						Back to inbox
					</Link>
					{canShowModeSwitch(user) && <ModeSwitch mode={mode} user={user} />}
					<h1 className="text-2xl font-bold tracking-tight text-neutral-900">{title}</h1>
					<label className="flex h-9 md:hidden items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 text-sm text-neutral-500 focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-500/20">
						<Search className="h-4 w-4 shrink-0" />
						<input
							type="search"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder={`Search ${title.toLowerCase()}`}
							aria-label={`Search ${title.toLowerCase()}`}
							className="min-w-0 flex-1 bg-transparent text-neutral-900 outline-none! border-none! shadow-none! p-0 placeholder:text-neutral-400"
						/>
					</label>
				</div>
				{groups.length === 0 && <p className="px-3 text-sm text-neutral-500">No pages match “{query.trim()}”.</p>}
				<NavResults groups={groups} mode={mode} pathname={pathname} />
				<a
					href={`${SOURCE_CODE_URL}/issues`}
					target="_blank"
					rel="noreferrer"
					className={cn(
						"flex items-center gap-3 border-t border-neutral-200/70 px-3 pt-4 text-sm text-neutral-600 hover:text-neutral-900",
						focusRing,
					)}
				>
					<LifeBuoy className="h-4 w-4" />
					Need a hand?
				</a>
			</div>
		</SectionNavSheet>
	);
}

"use client";

import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useKeyChanged } from "@/hooks/use-synced-state";
import { cn } from "@/lib/utils";
import { getNavMode, navModeLabels } from "@/components/settings/section-nav-utils";
import type { PageSearchResult } from "./page-search-types";
import {
	flattenPageResults,
	moveHighlight,
	pageSearchPlaceholder,
	resultToOpen,
	searchPages,
} from "./page-search-utils";
import { searchPillClass, searchPillInputClass } from "./search-pill";

/** The top-bar field on Settings and Admin pages; it finds pages in both menus and never searches mail. */
export function PageSearchInput() {
	const pathname = usePathname();
	const router = useRouter();
	const user = useCurrentUser();
	const listboxId = useId();
	const [query, setQuery] = useState("");
	const [open, setOpen] = useState(false);
	const [highlight, setHighlight] = useState(-1);

	if (useKeyChanged(pathname)) {
		setQuery("");
		setOpen(false);
		setHighlight(-1);
	}

	const mode = getNavMode(pathname);
	const placeholder = pageSearchPlaceholder(mode);
	const groups = searchPages(query, user, mode);
	const results = flattenPageResults(groups);
	const expanded = open && query.trim() !== "";
	const active = expanded ? results[highlight] : undefined;
	const activeId = active?.id;

	useEffect(() => {
		if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
	}, [activeId]);

	const openResult = (result: PageSearchResult | undefined) => {
		if (!result) return;
		setOpen(false);
		setHighlight(-1);
		setQuery("");
		router.push(result.href);
	};

	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			setOpen(true);
			setHighlight((index) => moveHighlight(index, results.length, event.key === "ArrowDown" ? "down" : "up"));
		} else if (event.key === "Enter") {
			event.preventDefault();
			if (expanded) openResult(resultToOpen(results, highlight));
		} else if (event.key === "Escape" && expanded) {
			event.preventDefault();
			event.stopPropagation();
			setOpen(false);
			setHighlight(-1);
		}
	};

	return (
		<>
			<div className="ml-auto md:hidden" />
			<div className="relative hidden min-w-0 flex-1 md:block">
				<div className={cn(searchPillClass, "flex")}>
					<Search className="h-5 w-5 shrink-0" />
					<Input
						role="combobox"
						aria-label={placeholder}
						aria-autocomplete="list"
						aria-expanded={expanded}
						aria-controls={listboxId}
						aria-activedescendant={activeId}
						autoComplete="off"
						value={query}
						onChange={(event) => {
							setQuery(event.target.value);
							setOpen(true);
							setHighlight(-1);
						}}
						onFocus={() => setOpen(true)}
						onBlur={() => setOpen(false)}
						onKeyDown={onKeyDown}
						placeholder={placeholder}
						className={searchPillInputClass}
					/>
					{query && (
						<button
							type="button"
							onMouseDown={(event) => event.preventDefault()}
							onClick={() => {
								setQuery("");
								setHighlight(-1);
							}}
							className="rounded-full p-1 text-neutral-500 hover:bg-blue-100 hover:text-neutral-800"
							aria-label="Clear search"
						>
							<X className="h-4 w-4" />
						</button>
					)}
				</div>
				<div
					className={cn(
						"absolute inset-x-0 top-full z-50 mt-2 max-h-[min(28rem,70dvh)] overflow-y-auto rounded-2xl border border-neutral-200 bg-white py-2 shadow-lg",
						!expanded && "hidden",
					)}
				>
					<div id={listboxId} role="listbox" aria-label={`${placeholder} results`}>
						{groups.map((group) => (
							<div key={group.mode} role="group" aria-label={navModeLabels[group.mode]}>
								<div
									aria-hidden="true"
									className="px-4 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-500"
								>
									{navModeLabels[group.mode]}
								</div>
								{group.results.map((result) => {
									const Icon = result.icon;
									const selected = result.id === activeId;
									return (
										<div
											key={result.id}
											id={result.id}
											role="option"
											aria-selected={selected}
											aria-label={result.label}
											onMouseDown={(event) => event.preventDefault()}
											onMouseMove={() => setHighlight(results.indexOf(result))}
											onClick={() => openResult(result)}
											className={cn(
												"mx-2 flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm",
												selected ? "bg-blue-100 text-blue-900" : "text-neutral-700",
											)}
										>
											<Icon className={cn("h-4 w-4 shrink-0", selected ? "text-blue-700" : "text-neutral-500")} />
											<span className="min-w-0 flex-1 truncate font-medium">{result.label}</span>
											{result.section && <span className="shrink-0 text-xs text-neutral-500">{result.section}</span>}
										</div>
									);
								})}
							</div>
						))}
					</div>
					{results.length === 0 && (
						<p role="status" className="px-4 py-2 text-sm text-neutral-500">
							No pages match “{query.trim()}”.
						</p>
					)}
				</div>
			</div>
		</>
	);
}

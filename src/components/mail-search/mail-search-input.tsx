"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useMailSearch } from "./mail-search-context";
import { panelSearchClass, searchPillClass, searchPillInputClass } from "./search-pill";
import { useShortcuts } from "@/components/shortcuts";
import type { ModuleSearchItem } from "@/lib/search/module-search-types";
import { SearchDropdown } from "./search-dropdown";
import { flattenSections, nextActiveIndex, searchItemKey } from "./search-dropdown-utils";
import { useModuleSearch } from "./use-module-search";

/**
 * The mail search. `panel` is the field inside the message list panel (Zero's "Search ⌘K"), always shown;
 * `header` is the top-bar pill that collapses to an icon on phones.
 */
export function MailSearchInput({ variant = "header" }: { variant?: "header" | "panel" }) {
	const panel = variant === "panel";
	const { input: query, setQuery } = useMailSearch();
	const { openCommandPalette, shortcutsEnabled, shortcutsPreferenceLoading } = useShortcuts();
	const showShortcutHints = shortcutsEnabled && !shortcutsPreferenceLoading;
	// On phones the field is an icon until tapped, then covers the header at full width.
	const [expanded, setExpanded] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const router = useRouter();
	const sections = useModuleSearch(query);
	const [focused, setFocused] = useState(false);
	// The text whose results were closed by Escape or a pick; typing again brings the dropdown back.
	const [closedFor, setClosedFor] = useState<string | null>(null);
	const [active, setActive] = useState(-1);
	const items = flattenSections(sections);
	const open = focused && items.length > 0 && closedFor !== query;

	function pick(item: ModuleSearchItem) {
		setClosedFor(query);
		inputRef.current?.blur();
		router.push(item.href);
	}

	function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
		if (!open) return;
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			setActive(nextActiveIndex(active, items.length, event.key));
		} else if (event.key === "Escape") {
			setClosedFor(query);
		} else if (event.key === "Enter" && items[active]) {
			// Without a highlighted row, Enter leaves the mail search it already runs untouched.
			event.preventDefault();
			pick(items[active]);
		}
	}

	useEffect(() => {
		if (expanded) inputRef.current?.focus();
	}, [expanded]);

	return (
		<>
			<button
				type="button"
				onClick={() => setExpanded(true)}
				hidden={panel}
				aria-label="Search mail"
				className={clsx(
					"ml-auto flex h-10 w-10 shrink-0 items-center justify-center rounded-full hover:bg-neutral-200 md:hidden",
					query ? "bg-blue-100 text-blue-700" : "text-neutral-600",
					expanded && "hidden",
				)}
			>
				<Search className="h-5 w-5" />
			</button>
			<div
				className={clsx(
					panel ? panelSearchClass : searchPillClass,
					"relative",
					!panel && "md:flex",
					!panel &&
						(expanded
							? "flex max-md:fixed max-md:inset-x-2 max-md:top-2 max-md:z-[60] max-md:shadow-md"
							: "max-md:hidden"),
				)}
			>
				<Search className="h-4 w-4 shrink-0" />
				<Input
					ref={inputRef}
					onFocus={() => setFocused(true)}
					onBlur={() => {
						setFocused(false);
						setExpanded(false);
					}}
					onKeyDown={onKeyDown}
					value={query}
					onChange={(event) => {
						setActive(-1);
						setClosedFor(null);
						setQuery(event.target.value);
					}}
					placeholder={showShortcutHints && !panel ? "Search mail (press / to focus)" : "Search mail"}
					className={searchPillInputClass}
				/>
				{query ? (
					<button
						type="button"
						onMouseDown={(event) => event.preventDefault()}
						onClick={() => setQuery("")}
						className="rounded-full p-1 text-neutral-500 hover:bg-blue-100 hover:text-neutral-800"
						aria-label="Clear search"
					>
						<X className="h-4 w-4" />
					</button>
				) : showShortcutHints ? (
					<button
						type="button"
						onClick={openCommandPalette}
						className="hidden sm:flex items-center gap-1 rounded-md bg-neutral-100 px-1.5 py-0.5 text-xs font-medium text-neutral-500 transition-colors hover:bg-neutral-200 hover:text-neutral-900"
						title="Open Command Palette (⌘K)"
					>
						<span className="text-[11px] font-mono">⌘K</span>
					</button>
				) : null}
				{open && (
					<SearchDropdown
						sections={sections}
						activeKey={items[active] ? searchItemKey(items[active]) : null}
						onPick={pick}
					/>
				)}
			</div>
		</>
	);
}

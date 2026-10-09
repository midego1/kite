"use client";

import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useMailSearch } from "./mail-search-context";
import { searchPillClass, searchPillInputClass } from "./search-pill";
import { useShortcuts } from "@/components/shortcuts";

export function MailSearchInput() {
	const { input: query, setQuery } = useMailSearch();
	const { openCommandPalette, shortcutsEnabled, shortcutsPreferenceLoading } = useShortcuts();
	const showShortcutHints = shortcutsEnabled && !shortcutsPreferenceLoading;
	// On phones the field is an icon until tapped, then covers the header at full width.
	const [expanded, setExpanded] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (expanded) inputRef.current?.focus();
	}, [expanded]);

	return (
		<>
			<button
				type="button"
				onClick={() => setExpanded(true)}
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
					searchPillClass,
					"md:flex",
					expanded ? "flex max-md:fixed max-md:inset-x-2 max-md:top-2 max-md:z-[60] max-md:shadow-md" : "max-md:hidden",
				)}
			>
				<Search className="h-5 w-5 shrink-0" />
				<Input
					ref={inputRef}
					onBlur={() => setExpanded(false)}
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder={showShortcutHints ? "Search mail (press / to focus)" : "Search mail"}
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
						className="hidden sm:flex items-center gap-1 px-2 py-0.5 text-xs font-medium text-neutral-500 bg-white/70 hover:bg-white border border-neutral-200/80 rounded-md shadow-2xs transition-colors"
						title="Open Command Palette (⌘K)"
					>
						<span className="text-[11px] font-mono">⌘K</span>
					</button>
				) : null}
			</div>
		</>
	);
}

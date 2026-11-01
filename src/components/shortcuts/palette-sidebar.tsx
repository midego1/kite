"use client";

import React, { useRef } from "react";
import clsx from "clsx";
import type { PaletteCategory, PaletteCategoryId } from "./palette-types";
import { NUMBERED_CATEGORIES, adjacentCategory } from "./palette-utils";

type PaletteSidebarProps = {
	categories: readonly PaletteCategory[];
	counts: Record<string, number>;
	active: PaletteCategoryId;
	panelId: string;
	onSelect: (id: PaletteCategoryId) => void;
};

export const categoryTabId = (panelId: string, id: PaletteCategoryId) => `${panelId}-tab-${id.replace(":", "-")}`;

/**
 * The category column (a chip row on phones): one tab per category with its number key and how many rows
 * it holds. Tabs are one Tab stop; the arrow keys move between them and choose as they go.
 */
export function PaletteSidebar({ categories, counts, active, panelId, onSelect }: PaletteSidebarProps) {
	const tabs = useRef(new Map<PaletteCategoryId, HTMLButtonElement>());

	function onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
		const next = adjacentCategory(categories, active, event.key);
		if (next === active) return;
		event.preventDefault();
		onSelect(next);
		tabs.current.get(next)?.focus();
	}

	return (
		<div
			role="tablist"
			aria-label="Categories"
			className="flex shrink-0 gap-2 overflow-x-auto border-b border-neutral-200 px-3 py-2 md:w-56 md:flex-col md:gap-0.5 md:overflow-y-auto md:border-b-0 md:border-r md:bg-neutral-50 md:p-2"
		>
			{categories.map((category, index) => {
				const Icon = category.icon;
				const selected = category.id === active;
				const count = counts[category.id] ?? 0;
				const digit = index < NUMBERED_CATEGORIES ? index + 1 : null;
				return (
					<button
						key={category.id}
						ref={(element) => {
							if (element) tabs.current.set(category.id, element);
							else tabs.current.delete(category.id);
						}}
						type="button"
						role="tab"
						id={categoryTabId(panelId, category.id)}
						aria-selected={selected}
						aria-controls={panelId}
						tabIndex={selected ? 0 : -1}
						title={digit ? `Alt+${digit}` : undefined}
						onClick={() => onSelect(category.id)}
						onKeyDown={onKeyDown}
						className={clsx(
							"flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-blue-500 md:w-full md:rounded-lg md:border-transparent md:px-2.5 md:py-2",
							selected
								? "border-blue-200 bg-blue-100 font-medium text-blue-900 md:bg-blue-100"
								: "border-neutral-200 text-neutral-700 hover:bg-neutral-100 md:hover:bg-neutral-200/60",
						)}
					>
						<Icon className="h-4 w-4 shrink-0 text-neutral-500" aria-hidden="true" />
						<span className="truncate">{category.label}</span>
						<span className="ml-auto flex items-center gap-1.5 pl-1">
							{digit !== null && (
								<kbd
									aria-hidden="true"
									className="hidden rounded border border-neutral-200 bg-white px-1 font-mono text-[10px] leading-4 text-neutral-500 md:inline-block"
								>
									{digit}
								</kbd>
							)}
							<span
								aria-hidden="true"
								data-palette-count={count}
								className={clsx(
									"min-w-5 rounded-full px-1.5 text-center text-[11px] font-medium leading-5 tabular-nums",
									count > 0 ? "bg-neutral-200 text-neutral-700" : "text-neutral-400",
								)}
							>
								{count}
							</span>
							<span className="sr-only">{`${count} ${count === 1 ? "result" : "results"}`}</span>
						</span>
					</button>
				);
			})}
		</div>
	);
}

"use client";

import React, { useEffect } from "react";
import clsx from "clsx";
import type { PaletteCategory, PaletteCategoryId, PaletteGroup, PaletteItem } from "./palette-types";
import { emptyMessage, shortcutKeys } from "./palette-utils";

export const optionId = (listboxId: string, index: number) => `${listboxId}-option-${index}`;

function PaletteOption({
	item,
	id,
	icon: FallbackIcon,
	selected,
	onActivate,
	onSelect,
}: {
	item: PaletteItem;
	id: string;
	icon: PaletteCategory["icon"];
	selected: boolean;
	onActivate: () => void;
	onSelect: () => void;
}) {
	const Icon = item.icon ?? FallbackIcon;
	return (
		// Hovering highlights like the arrow keys do; a click runs the row. The option has no tab stop of its own:
		// the listbox and the search box point at it with aria-activedescendant.
		<div
			role="option"
			id={id}
			aria-selected={selected}
			data-palette-item={item.id}
			onMouseMove={onActivate}
			onClick={onSelect}
			className={clsx(
				"group/row flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-neutral-900",
				selected ? "bg-neutral-100 shadow-sm ring-1 ring-neutral-200" : "hover:bg-neutral-50",
			)}
		>
			<span
				aria-hidden="true"
				className={clsx(
					"flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
					selected ? "bg-white text-neutral-700" : "bg-neutral-100 text-neutral-500",
				)}
			>
				<Icon className="h-4 w-4" />
			</span>
			<span className="flex min-w-0 flex-1 flex-col">
				<span className="flex min-w-0 items-center gap-2">
					<span data-palette-title className="truncate text-sm font-semibold">
						{item.title}
					</span>
					<span className="shrink-0 rounded border border-neutral-200 bg-white px-1.5 text-[10px] font-semibold uppercase leading-4 tracking-wider text-neutral-500">
						{item.type}
					</span>
				</span>
				{item.subtitle && <span className="truncate text-xs text-neutral-500">{item.subtitle}</span>}
			</span>
			{item.shortcut && (
				<span className="hidden shrink-0 items-center gap-1 sm:flex" aria-label={`Shortcut ${item.shortcut}`}>
					{shortcutKeys(item.shortcut).map((key, index) => (
						<kbd
							key={index}
							className="rounded-md border border-neutral-200 bg-neutral-50 px-1.5 font-mono text-[11px] font-medium leading-5 text-neutral-500"
						>
							{key}
						</kbd>
					))}
				</span>
			)}
		</div>
	);
}

type PaletteResultsProps = {
	groups: readonly PaletteGroup[];
	listboxId: string;
	activeIndex: number;
	query: string;
	category: PaletteCategoryId;
	loading: boolean;
	onActivate: (index: number) => void;
	onSelect: (item: PaletteItem) => void;
};

/**
 * The result rows under their group headings. One listbox for every group, so the arrow keys walk the
 * whole list and the active row is announced through aria-activedescendant.
 */
export function PaletteResults({
	groups,
	listboxId,
	activeIndex,
	query,
	category,
	loading,
	onActivate,
	onSelect,
}: PaletteResultsProps) {
	useEffect(() => {
		if (activeIndex < 0) return;
		document.getElementById(optionId(listboxId, activeIndex))?.scrollIntoView({ block: "nearest" });
	}, [activeIndex, listboxId]);

	let index = -1;
	const empty = groups.length === 0;
	return (
		<div
			role="listbox"
			id={listboxId}
			aria-label="Results"
			aria-busy={loading || undefined}
			aria-activedescendant={activeIndex >= 0 ? optionId(listboxId, activeIndex) : undefined}
			tabIndex={0}
			className="min-h-0 flex-1 overflow-y-auto p-2 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 md:max-h-[min(60vh,34rem)]"
		>
			{empty ? (
				<div role="status" className="px-4 py-10 text-center text-sm text-neutral-500">
					{emptyMessage(query, category, loading)}
				</div>
			) : (
				groups.map((group) => {
					const headingId = `${listboxId}-group-${group.category.id.replace(":", "-")}`;
					return (
						<div key={group.category.id} role="group" aria-labelledby={headingId} className="mb-2 last:mb-0">
							<div
								id={headingId}
								className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-500"
							>
								{group.category.label}
							</div>
							{group.items.map((item) => {
								index += 1;
								const at = index;
								return (
									<PaletteOption
										key={item.id}
										item={item}
										id={optionId(listboxId, at)}
										icon={group.category.icon}
										selected={at === activeIndex}
										onActivate={() => onActivate(at)}
										onSelect={() => onSelect(item)}
									/>
								);
							})}
						</div>
					);
				})
			)}
		</div>
	);
}

const FOOTER_KEYS: [string, string][] = [
	["↑", "Move up"],
	["↓", "Move down"],
	["↵", "Open"],
	["Esc", "Close"],
];

export function PaletteFooter() {
	return (
		<div className="flex items-center justify-between border-t border-neutral-200 bg-neutral-50 px-4 py-2 text-xs text-neutral-500">
			<span className="font-medium">Kite search</span>
			<span className="hidden items-center gap-1.5 md:flex">
				{FOOTER_KEYS.map(([key, label]) => (
					<kbd
						key={key}
						title={label}
						className="rounded-md border border-neutral-200 bg-white px-1.5 font-mono text-[11px] leading-5 text-neutral-500"
					>
						{key}
					</kbd>
				))}
			</span>
		</div>
	);
}

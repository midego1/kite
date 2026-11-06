"use client";

import { useRef, type KeyboardEvent } from "react";
import { Check } from "lucide-react";
import { logicalArrowKey } from "@/components/interface-direction-utils";
import type { LayoutLabelColor } from "@/lib/preferences/layout-types";
import { cn } from "@/lib/utils";
import { LABEL_COLORS } from "./label-colors-utils";

/**
 * Picks the colour of a mailbox's dot or an account's icon: the palette as round swatches plus one for "no choice"
 * (`defaultLabel`: the automatic colour, or the neutral icon). One tab stop; the arrow keys move and choose.
 */
export function LabelColorPicker({
	id,
	label,
	value,
	defaultLabel,
	defaultGlyph,
	onChange,
	className,
}: {
	/** Lets the setting row's label point at the group. */
	id?: string;
	/** What the colour is for, e.g. "Colour for Work desk". */
	label: string;
	value: LayoutLabelColor | undefined;
	defaultLabel: string;
	/** The mark in the default's empty circle: "A" for automatic, a dash for no colour. */
	defaultGlyph: string;
	onChange: (color: LayoutLabelColor | null) => void;
	className?: string;
}) {
	const refs = useRef<(HTMLButtonElement | null)[]>([]);
	const options: { id: LayoutLabelColor | null; name: string; swatch: string | null }[] = [
		{ id: null, name: defaultLabel, swatch: null },
		...LABEL_COLORS.map((color) => ({ id: color.id, name: color.label, swatch: color.value })),
	];
	const selected = Math.max(
		0,
		options.findIndex((option) => option.id === (value ?? null)),
	);
	function move(event: KeyboardEvent, index: number) {
		const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[logicalArrowKey(event.key)];
		if (!step) return;
		event.preventDefault();
		const next = (index + step + options.length) % options.length;
		refs.current[next]?.focus();
		onChange(options[next].id);
	}
	return (
		<div id={id} role="radiogroup" aria-label={label} className={cn("flex flex-wrap items-center gap-1.5", className)}>
			{options.map((option, index) => {
				const checked = index === selected;
				return (
					<button
						key={option.id ?? "default"}
						ref={(node) => {
							refs.current[index] = node;
						}}
						type="button"
						role="radio"
						aria-checked={checked}
						aria-label={option.name}
						title={option.name}
						data-label-color={option.id ?? "default"}
						tabIndex={checked ? 0 : -1}
						onClick={() => onChange(option.id)}
						onKeyDown={(event) => move(event, index)}
						className={cn(
							"flex h-6 w-6 items-center justify-center rounded-full border-2 transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-1",
							checked ? "border-neutral-900" : "border-transparent",
							option.swatch === null && "border-dashed border-neutral-400",
							option.swatch === null && checked && "border-solid border-neutral-900",
						)}
						style={option.swatch ? { backgroundColor: option.swatch } : undefined}
					>
						{option.id === null ? (
							<span aria-hidden className="text-[10px] font-semibold leading-none text-neutral-600">
								{defaultGlyph}
							</span>
						) : (
							checked && <Check aria-hidden className="h-3 w-3 text-[#fff]" strokeWidth={3} />
						)}
					</button>
				);
			})}
		</div>
	);
}

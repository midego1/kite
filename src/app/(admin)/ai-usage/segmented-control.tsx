"use client";

import { useRef, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";

/** A row of mutually exclusive buttons that behaves as a radio group: arrow keys move and choose. */
export function SegmentedControl<T extends string | number>({
	label,
	value,
	options,
	onChange,
	disabled,
}: {
	label: string;
	value: T;
	options: readonly { value: T; label: string }[];
	onChange: (value: T) => void;
	disabled?: boolean;
}) {
	const refs = useRef<(HTMLButtonElement | null)[]>([]);
	const move = (event: KeyboardEvent, index: number) => {
		const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
		if (!step) return;
		event.preventDefault();
		const next = (index + step + options.length) % options.length;
		refs.current[next]?.focus();
		onChange(options[next].value);
	};
	return (
		<div
			role="radiogroup"
			aria-label={label}
			className="inline-flex rounded-lg border border-neutral-200 bg-[#f6f8fc] p-0.5 text-sm"
		>
			{options.map((option, index) => {
				const checked = option.value === value;
				return (
					<button
						key={option.value}
						ref={(node) => {
							refs.current[index] = node;
						}}
						type="button"
						role="radio"
						aria-checked={checked}
						tabIndex={checked ? 0 : -1}
						disabled={disabled}
						onClick={() => onChange(option.value)}
						onKeyDown={(event) => move(event, index)}
						className={cn(
							"rounded-md px-3 py-1 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-60",
							checked ? "bg-white text-neutral-900 shadow-sm" : "text-neutral-500 hover:text-neutral-900",
						)}
					>
						{option.label}
					</button>
				);
			})}
		</div>
	);
}

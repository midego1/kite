"use client";

import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useStoredState } from "@/hooks/use-stored-state";

/** Open/closed state of a menu section, remembered in localStorage. Starts open. */
export function useSectionOpen(storageKey: string): [boolean, () => void] {
	const [open, setOpen] = useStoredState(storageKey, true);
	function toggle() {
		setOpen(!open);
	}
	return [open, toggle];
}

export function NavSectionHeader({
	label,
	open,
	onToggle,
	children,
}: {
	label: string;
	open: boolean;
	onToggle: () => void;
	children?: ReactNode;
}) {
	return (
		<div className="mt-3 flex h-7 shrink-0 items-center justify-between pl-6 pr-4">
			<button
				type="button"
				onClick={onToggle}
				aria-expanded={open}
				className="flex items-center gap-1 text-xs font-medium text-neutral-500 hover:text-neutral-900 max-md:text-sm"
			>
				{label}
				<ChevronDown className={cn("h-3.5 w-3.5 transition-transform", !open && "-rotate-90")} />
			</button>
			{children}
		</div>
	);
}

/** A small muted label over a group of menu links that does not fold, like Zero's "Core". */
export function NavSectionLabel({ label }: { label: string }) {
	return <p className="mt-1 flex h-7 shrink-0 items-center pl-6 text-xs font-medium text-neutral-500">{label}</p>;
}

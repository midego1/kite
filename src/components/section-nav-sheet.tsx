"use client";

import clsx from "clsx";
import { ChevronUp } from "lucide-react";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useKeyChanged } from "@/hooks/use-synced-state";
import { useIsMobile } from "./sidebar-mobile-utils";

type SectionNavSheetProps = {
	label: string;
	title: string;
	children: ReactNode;
	className?: string;
	/** Controlled: whether the phone sheet is open; the caller then draws its own trigger. */
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
};

// Inline column from md up; on phones a bottom sheet opened from a floating pill showing the current section,
// or from the caller's own button when it controls `open` (the Calendar keeps its header free of the grid).
export function SectionNavSheet({
	label,
	title,
	children,
	className,
	open: openProp,
	onOpenChange,
}: SectionNavSheetProps) {
	const mobile = useIsMobile();
	const pathname = usePathname();
	const [ownOpen, setOwnOpen] = useState(false);
	const controlled = openProp !== undefined;
	const open = controlled ? openProp : ownOpen;
	const setOpen = useCallback(
		(next: boolean) => {
			if (!controlled) setOwnOpen(next);
			onOpenChange?.(next);
		},
		[controlled, onOpenChange],
	);
	const hidden = mobile && !open;

	if (useKeyChanged(`${pathname}|${mobile}`) && open) setOpen(false);

	useEffect(() => {
		if (!open) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [open, setOpen]);

	return (
		<>
			{!controlled && (
				// Above the phone tab bar (3.75rem plus the safe-area inset), with the same 0.75rem gap the bar leaves.
				<button
					type="button"
					onClick={() => setOpen(true)}
					aria-haspopup="dialog"
					aria-expanded={open}
					className="fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom))] left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-full bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white shadow-lg md:hidden"
				>
					<span className="max-w-[60vw] truncate">{label}</span>
					<ChevronUp size={16} aria-hidden="true" />
				</button>
			)}
			<div
				onClick={() => setOpen(false)}
				aria-hidden="true"
				className={clsx(
					"fixed inset-0 z-[100] bg-black/40 transition-opacity duration-200 ease-out motion-reduce:transition-none md:hidden",
					open ? "opacity-100" : "pointer-events-none opacity-0",
				)}
			/>
			<aside
				role={mobile ? "dialog" : undefined}
				aria-label={title}
				aria-hidden={hidden}
				inert={hidden}
				className={clsx(
					"fixed inset-x-0 bottom-0 z-[110] max-h-[85dvh] overflow-y-auto overscroll-contain max-md:rounded-t-2xl max-md:border-t max-md:border-neutral-200 bg-white pb-[env(safe-area-inset-bottom)] max-md:shadow-2xl transition-transform duration-300 ease-out motion-reduce:transition-none",
					// From md up the caller draws the column (the Settings and Admin menu panel).
					"md:static md:z-auto md:max-h-none md:translate-y-0 md:overflow-visible md:pb-0",
					open ? "translate-y-0" : "translate-y-full",
					className,
				)}
			>
				<div className="flex justify-center pt-3 md:hidden" onClick={() => setOpen(false)}>
					<span className="h-1.5 w-10 rounded-full bg-neutral-300" />
				</div>
				{children}
			</aside>
		</>
	);
}

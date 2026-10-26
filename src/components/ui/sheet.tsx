"use client";

// Ported from the shadcn/ui new-york Sheet (MIT, see NOTICE): a Radix Dialog that slides in from an edge,
// restyled with Kite's palette and the dialog animations in globals.css.
import * as SheetPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";
import { useReturnFocus } from "./use-return-focus";

export const Sheet = SheetPrimitive.Root;
export const SheetTitle = SheetPrimitive.Title;

export function SheetContent({
	side = "left",
	className,
	children,
	closeLabel = "Close",
	portal = true,
	returnFocusTo,
	...props
}: React.ComponentPropsWithoutRef<typeof SheetPrimitive.Content> & {
	side?: "left" | "right";
	closeLabel?: string;
	/** Off keeps the sheet where it is rendered in the DOM instead of moving it to the end of `body`. */
	portal?: boolean;
	/** The element focus returns to on close, for a sheet opened by a button outside its Root. */
	returnFocusTo?: () => HTMLElement | null;
}) {
	const Container = portal ? SheetPrimitive.Portal : React.Fragment;
	const returnFocus = useReturnFocus(returnFocusTo);
	return (
		<Container>
			<SheetPrimitive.Overlay className="dialog-overlay fixed inset-0 z-[100] bg-black/40" />
			<SheetPrimitive.Content
				data-side={side}
				className={cn(
					"sheet-content fixed inset-y-0 z-[110] flex w-[min(85vw,300px)] flex-col bg-white shadow-xl focus:outline-none",
					side === "left" ? "left-0" : "right-0",
					className,
				)}
				{...returnFocus}
				{...props}
			>
				{children}
				<SheetPrimitive.Close className="absolute right-3 top-3 rounded-full p-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600">
					<X className="h-4 w-4" />
					<span className="sr-only">{closeLabel}</span>
				</SheetPrimitive.Close>
			</SheetPrimitive.Content>
		</Container>
	);
}

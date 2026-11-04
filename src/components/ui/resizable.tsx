"use client";

// Ported from the shadcn/ui new-york Resizable (MIT, see NOTICE) to react-resizable-panels 4, whose sizes
// take pixel values, and restyled with Kite's palette. Kite's handle is a hairline with a wider invisible
// hit area that turns blue while hovered, focused or dragged.
import { Children } from "react";
import * as ResizablePrimitive from "react-resizable-panels";
import { useInterfaceDirection } from "@/components/interface-direction-provider";
import { cn } from "@/lib/utils";

/**
 * The library measures drags and arrow keys physically and takes the panel before a separator to be on its left, so
 * under `dir="rtl"` it would grow the wrong panel. A mirrored side-by-side group therefore stays a left-to-right flex
 * row with its panels in reverse order, and each panel reads right to left inside. Sizes are keyed by panel id, so
 * saved ones stay valid. Switching direction remounts the group, because the library only orders panels on mount.
 */
export function ResizablePanelGroup({
	className,
	children,
	...props
}: React.ComponentProps<typeof ResizablePrimitive.Group>) {
	const mirrored = useInterfaceDirection() === "rtl" && props.orientation !== "vertical";
	return (
		<ResizablePrimitive.Group
			key={mirrored ? "mirrored" : "plain"}
			className={cn("h-full w-full", mirrored && "[direction:ltr] *:[direction:rtl]", className)}
			{...props}
		>
			{mirrored ? Children.toArray(children).reverse() : children}
		</ResizablePrimitive.Group>
	);
}

export const ResizablePanel = ResizablePrimitive.Panel;

export function ResizableHandle({ className, ...props }: React.ComponentProps<typeof ResizablePrimitive.Separator>) {
	return (
		<ResizablePrimitive.Separator
			className={cn(
				"relative z-20 flex w-px shrink-0 items-center justify-center bg-neutral-200 outline-none transition-colors",
				"after:absolute after:inset-y-0 after:left-1/2 after:w-2 after:-translate-x-1/2",
				"data-[separator=active]:bg-blue-600 data-[separator=focus]:bg-blue-600 data-[separator=hover]:bg-blue-400",
				"aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:after:inset-x-0 aria-[orientation=horizontal]:after:inset-y-auto aria-[orientation=horizontal]:after:left-0 aria-[orientation=horizontal]:after:top-1/2 aria-[orientation=horizontal]:after:h-2 aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:translate-x-0 aria-[orientation=horizontal]:after:-translate-y-1/2",
				className,
			)}
			{...props}
		/>
	);
}

export { usePanelRef } from "react-resizable-panels";

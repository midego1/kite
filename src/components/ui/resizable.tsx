"use client";

// Ported from the shadcn/ui new-york Resizable (MIT, see NOTICE) to react-resizable-panels 4, whose sizes
// take pixel values, and restyled with Kite's palette. Kite's handle is a hairline with a wider invisible
// hit area that turns blue while hovered, focused or dragged.
import * as ResizablePrimitive from "react-resizable-panels";
import { cn } from "@/lib/utils";

export function ResizablePanelGroup({ className, ...props }: React.ComponentProps<typeof ResizablePrimitive.Group>) {
	return <ResizablePrimitive.Group className={cn("h-full w-full", className)} {...props} />;
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

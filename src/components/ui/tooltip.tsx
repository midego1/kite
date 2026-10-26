"use client";

// Ported from the shadcn/ui new-york Tooltip (MIT, see NOTICE), restyled with Kite's palette. The
// `label` API is Kite's: one call wraps its trigger, and `null` renders the children alone.
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "@/lib/utils";
import type { TooltipProps } from "./tooltip-types";
import { tooltipSide } from "./tooltip-utils";

export function Tooltip({ label, children, className, placement = "auto" }: TooltipProps) {
	if (!label) return children;

	return (
		<TooltipPrimitive.Provider delayDuration={0} skipDelayDuration={300}>
			<TooltipPrimitive.Root disableHoverableContent>
				<TooltipPrimitive.Trigger asChild>
					<span className={cn("inline-flex", className)}>{children}</span>
				</TooltipPrimitive.Trigger>
				<TooltipPrimitive.Portal>
					<TooltipPrimitive.Content
						side={tooltipSide(placement)}
						sideOffset={8}
						collisionPadding={8}
						className="pointer-events-none z-[100] max-w-[min(20rem,calc(100vw-1rem))] rounded-md bg-neutral-900 px-2 py-1 text-center text-xs font-medium text-white shadow-lg"
					>
						{label}
					</TooltipPrimitive.Content>
				</TooltipPrimitive.Portal>
			</TooltipPrimitive.Root>
		</TooltipPrimitive.Provider>
	);
}

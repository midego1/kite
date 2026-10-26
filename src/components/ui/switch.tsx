"use client";

// Ported from the shadcn/ui new-york Switch (MIT, see NOTICE), restyled with Kite's palette.
import * as SwitchPrimitive from "@radix-ui/react-switch";
import * as React from "react";
import { cn } from "@/lib/utils";
import type { SwitchProps } from "./switch-types";

export const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(({ className, ...props }, ref) => (
	<SwitchPrimitive.Root
		ref={ref}
		className={cn(
			"peer relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-blue-600 data-[state=unchecked]:bg-neutral-300",
			className,
		)}
		{...props}
	>
		<SwitchPrimitive.Thumb className="pointer-events-none block h-5 w-5 rounded-full bg-white shadow-sm transition-transform data-[state=checked]:translate-x-[21px] data-[state=unchecked]:translate-x-0.5" />
	</SwitchPrimitive.Root>
));
Switch.displayName = "Switch";

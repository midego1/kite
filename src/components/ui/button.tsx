"use client";

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { useHydrated } from "@/hooks/use-hydrated";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
	"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
	{
		variants: {
			variant: {
				default: "bg-blue-600 text-white hover:bg-blue-700",
				outline: "border border-neutral-200 bg-white hover:bg-neutral-100",
				ghost: "hover:bg-neutral-100",
				destructive: "bg-red-600 text-white hover:bg-red-700",
			},
			size: {
				default: "h-9 rounded-lg px-4 py-2",
				sm: "h-8 rounded-lg px-3 text-xs",
				lg: "h-10 rounded-lg px-6",
				roundedSM: "rounded-full p-2 text-xs",
				icon: "h-9 w-9 shrink-0 rounded-lg p-0",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	},
);

export interface ButtonProps
	extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
	asChild?: boolean;
}

/**
 * Until React has hydrated a server-rendered page, a button has no handler: a click does nothing, or a submit
 * button posts the form natively. So a button is disabled until then (only for that first render; later mounts
 * are interactive at once): the browser drops an early click, and Enter in a field no longer submits the form.
 * Playwright waits for it to be enabled. It keeps its look meanwhile.
 */
const HYDRATING_CLASS =
	"data-hydrating:disabled:pointer-events-auto data-hydrating:disabled:cursor-progress data-hydrating:disabled:opacity-100";

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
	({ className, variant, size, asChild = false, ...props }, ref) => {
		const hydrated = useHydrated();
		if (asChild) {
			// A link or other child keeps its own behaviour, which works without JavaScript.
			return (
				<Slot className={cn("cursor-pointer", buttonVariants({ variant, size, className }))} ref={ref} {...props} />
			);
		}
		return (
			<button
				className={cn("cursor-pointer", buttonVariants({ variant, size, className }), HYDRATING_CLASS)}
				ref={ref}
				{...props}
				disabled={props.disabled || !hydrated}
				data-hydrating={hydrated ? undefined : ""}
			/>
		);
	},
);
Button.displayName = "Button";

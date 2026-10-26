"use client";

// Ported from the shadcn/ui new-york Checkbox (MIT, see NOTICE), restyled with Kite's palette. It keeps the
// native checkbox's `onChange(event)` API: `event.target.checked` is the new state and `event.nativeEvent`
// the click that caused it, so Shift-click range selection keeps working.
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";
import type { CheckboxProps } from "./checkbox-types";

export const Checkbox = React.forwardRef<HTMLButtonElement, CheckboxProps>(
	({ className, onChange, onClick, name, value, ...props }, ref) => {
		const lastClick = React.useRef<{ event: Event; target: HTMLButtonElement } | null>(null);
		return (
			<CheckboxPrimitive.Root
				ref={ref}
				name={name}
				value={value}
				className={cn(
					"peer grid h-4 w-4 shrink-0 cursor-pointer place-content-center rounded-[3px] border border-neutral-500 bg-white text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-blue-600 data-[state=checked]:bg-blue-600",
					className,
				)}
				onClick={(event) => {
					lastClick.current = { event: event.nativeEvent, target: event.currentTarget };
					onClick?.(event);
				}}
				onCheckedChange={(checked) => {
					const click = lastClick.current;
					lastClick.current = null;
					if (!onChange || !click) return;
					onChange({
						target: { checked: checked === true, name: name ?? "", value: value === undefined ? "on" : String(value) },
						currentTarget: click.target,
						nativeEvent: click.event,
					});
				}}
				{...props}
			>
				<CheckboxPrimitive.Indicator className="grid place-content-center text-current">
					<Check className="h-3.5 w-3.5" strokeWidth={3} />
				</CheckboxPrimitive.Indicator>
			</CheckboxPrimitive.Root>
		);
	},
);
Checkbox.displayName = "Checkbox";

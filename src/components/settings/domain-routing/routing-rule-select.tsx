import * as React from "react";
import { Select } from "@/components/ui/select";
import type { SelectProps } from "@/components/ui/select-types";
import { cn } from "@/lib/utils";

/** The full-width select of the rule forms. */
export const RoutingRuleSelect = React.forwardRef<HTMLButtonElement, SelectProps>(
	({ className, containerClassName, ...props }, ref) => (
		<Select
			ref={ref}
			containerClassName={cn("h-10 w-full min-w-0", containerClassName)}
			className={cn("text-sm", className)}
			{...props}
		/>
	),
);
RoutingRuleSelect.displayName = "RoutingRuleSelect";

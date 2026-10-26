import type * as SwitchPrimitive from "@radix-ui/react-switch";
import type * as React from "react";

export type SwitchProps = Omit<
	React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>,
	"checked" | "defaultChecked" | "onCheckedChange" | "role"
> & {
	checked: boolean;
	onCheckedChange: (checked: boolean) => void;
};

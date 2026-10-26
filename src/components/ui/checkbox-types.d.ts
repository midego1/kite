import type * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import type * as React from "react";

/** What a Checkbox's `onChange` receives: the new state and the click or key event that toggled it. */
export type CheckboxChangeEvent = {
	target: { checked: boolean; name: string; value: string };
	currentTarget: HTMLButtonElement;
	nativeEvent: Event;
};

export type CheckboxProps = Omit<
	React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>,
	"checked" | "defaultChecked" | "onCheckedChange" | "onChange"
> & {
	checked?: boolean;
	defaultChecked?: boolean;
	onChange?: (event: CheckboxChangeEvent) => void;
};

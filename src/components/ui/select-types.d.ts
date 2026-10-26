import type * as React from "react";

/** What a Select's `onChange` receives: `event.target.value` is the chosen option's value. */
export type SelectChangeEvent = {
	target: { name: string; value: string };
	currentTarget: { name: string; value: string };
};

export type SelectProps = Omit<
	React.ComponentPropsWithoutRef<"button">,
	"value" | "defaultValue" | "onChange" | "type" | "children"
> & {
	/** `<option>` and `<optgroup>` elements, as for a native select. */
	children?: React.ReactNode;
	value?: string | number;
	defaultValue?: string | number;
	name?: string;
	required?: boolean;
	onChange?: (event: SelectChangeEvent) => void;
	containerClassName?: string;
};

export type SelectOption = {
	value: string;
	label: React.ReactNode;
	text: string;
	disabled: boolean;
};

export type SelectOptionGroup = {
	label: string | null;
	options: SelectOption[];
};

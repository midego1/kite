import { Children, Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import type { SelectOption, SelectOptionGroup } from "./select-types";

// Radix Select reserves the empty string for "no value", so a native `<option value="">` maps to this.
const EMPTY_OPTION_VALUE = "__kite-select-empty__";

type OptionProps = { value?: string | number; disabled?: boolean; children?: ReactNode; label?: string };
type GroupProps = { label?: string; disabled?: boolean; children?: ReactNode };

export function toItemValue(value: string): string {
	return value === "" ? EMPTY_OPTION_VALUE : value;
}

export function fromItemValue(value: string): string {
	return value === EMPTY_OPTION_VALUE ? "" : value;
}

function nodeText(node: ReactNode): string {
	if (node === null || node === undefined || typeof node === "boolean") return "";
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(nodeText).join("");
	if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
	return "";
}

function toOption(element: ReactElement<OptionProps>, groupDisabled: boolean): SelectOption {
	const { value, disabled, children, label } = element.props;
	const text = label ?? nodeText(children);
	return {
		value: value === undefined ? text : String(value),
		label: label ?? children,
		text,
		disabled: groupDisabled || disabled === true,
	};
}

/** Reads native `<option>`/`<optgroup>` children (through arrays and fragments) into groups of options. */
export function readSelectOptions(children: ReactNode): SelectOptionGroup[] {
	const groups: SelectOptionGroup[] = [];
	const loose = (): SelectOption[] => {
		const last = groups.at(-1);
		if (last && last.label === null) return last.options;
		const group: SelectOptionGroup = { label: null, options: [] };
		groups.push(group);
		return group.options;
	};
	const visit = (nodes: ReactNode, into: SelectOption[] | null, groupDisabled: boolean) => {
		Children.forEach(nodes, (node) => {
			if (!isValidElement(node)) return;
			if (node.type === Fragment) {
				visit((node.props as { children?: ReactNode }).children, into, groupDisabled);
			} else if (node.type === "option") {
				(into ?? loose()).push(toOption(node as ReactElement<OptionProps>, groupDisabled));
			} else if (node.type === "optgroup") {
				const props = node.props as GroupProps;
				const group: SelectOptionGroup = { label: props.label ?? "", options: [] };
				groups.push(group);
				visit(props.children, group.options, props.disabled === true);
			}
		});
	};
	visit(children, null, false);
	return groups.filter((group) => group.options.length > 0);
}

/**
 * The option a native select would show: the one matching `value`, else the first enabled option
 * (a select with no matching option displays and submits its first option).
 */
export function resolveSelectedOption(groups: SelectOptionGroup[], value: string | undefined): SelectOption | null {
	const options = groups.flatMap((group) => group.options);
	if (value !== undefined) {
		const match = options.find((option) => option.value === value);
		if (match) return match;
	}
	return options.find((option) => !option.disabled) ?? options[0] ?? null;
}

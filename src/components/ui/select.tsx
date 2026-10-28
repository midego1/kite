"use client";

// Ported from the shadcn/ui new-york Select (MIT, see NOTICE), restyled with Kite's palette. It keeps the
// native select's API: `<option>`/`<optgroup>` children and `onChange(event)` with `event.target.value`.
// A hidden native select carries `name` and `required` for forms, as Radix's own form control does.
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";
import type { SelectProps } from "./select-types";
import {
	fromItemValue,
	longestOptionText,
	readSelectOptions,
	resolveSelectedOption,
	toItemValue,
} from "./select-utils";

export const Select = React.forwardRef<HTMLButtonElement, SelectProps>(
	(
		{ className, containerClassName, children, value, defaultValue, onChange, name, required, disabled, ...props },
		ref,
	) => {
		const groups = readSelectOptions(children);
		const options = groups.flatMap((group) => group.options);
		const triggerRef = React.useRef<HTMLButtonElement | null>(null);
		const setTriggerRef = (node: HTMLButtonElement | null) => {
			triggerRef.current = node;
			if (typeof ref === "function") ref(node);
			else if (ref) ref.current = node;
		};
		const [uncontrolled, setUncontrolled] = React.useState(
			defaultValue === undefined ? undefined : String(defaultValue),
		);
		const current = value === undefined ? uncontrolled : String(value);
		const selected = resolveSelectedOption(groups, current);
		const formValue = selected?.value ?? "";

		const choose = (itemValue: string) => {
			const next = fromItemValue(itemValue);
			if (value === undefined) setUncontrolled(next);
			const target = { name: name ?? "", value: next };
			onChange?.({ target, currentTarget: target });
		};

		return (
			<span
				className={cn(
					// The trigger drops its own outline; the field draws the keyboard focus ring instead.
					"relative inline-flex rounded-lg border border-neutral-200 px-2 has-[button:focus-visible]:border-blue-500 has-[button:focus-visible]:ring-2 has-[button:focus-visible]:ring-blue-500/50",
					containerClassName,
				)}
			>
				<SelectPrimitive.Root
					value={selected ? toItemValue(selected.value) : undefined}
					onValueChange={choose}
					disabled={disabled}
				>
					<SelectPrimitive.Trigger
						ref={setTriggerRef}
						aria-required={required || undefined}
						data-value={formValue}
						className={cn(
							"flex w-full min-w-0 cursor-pointer items-center justify-between gap-1 rounded-md bg-transparent text-left focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
							className,
						)}
						{...props}
					>
						{/* Like a native select, the trigger is as wide as its longest option: a hidden copy sizes the cell. */}
						<span className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)] [&>*]:col-start-1 [&>*]:row-start-1">
							<span aria-hidden="true" className="invisible h-0 whitespace-nowrap">
								{longestOptionText(options)}
							</span>
							<span className="truncate">
								<SelectPrimitive.Value>{selected?.label}</SelectPrimitive.Value>
							</span>
						</span>
						<SelectPrimitive.Icon asChild>
							<ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 text-neutral-500" />
						</SelectPrimitive.Icon>
					</SelectPrimitive.Trigger>
					<SelectPrimitive.Portal>
						<SelectPrimitive.Content
							position="popper"
							sideOffset={4}
							collisionPadding={8}
							className="relative z-[200] max-h-[min(var(--radix-select-content-available-height),24rem)] min-w-[max(8rem,var(--radix-select-trigger-width))] overflow-hidden rounded-lg border border-neutral-200 bg-white text-neutral-900 shadow-lg"
						>
							<SelectPrimitive.ScrollUpButton className="flex cursor-default items-center justify-center py-1 text-neutral-500">
								<ChevronUp className="h-4 w-4" />
							</SelectPrimitive.ScrollUpButton>
							<SelectPrimitive.Viewport className="p-1">
								{groups.map((group, index) => (
									<SelectPrimitive.Group key={group.label ?? `group-${index}`}>
										{index > 0 && <SelectPrimitive.Separator className="-mx-1 my-1 h-px bg-neutral-200" />}
										{group.label !== null && (
											<SelectPrimitive.Label className="px-2 py-1.5 text-xs font-semibold text-neutral-500">
												{group.label}
											</SelectPrimitive.Label>
										)}
										{group.options.map((option) => (
											<SelectPrimitive.Item
												key={option.value}
												value={toItemValue(option.value)}
												data-value={option.value}
												textValue={option.text}
												disabled={option.disabled}
												className="relative flex w-full cursor-default select-none items-center rounded-md py-1.5 pl-2 pr-8 text-sm outline-none data-[disabled]:pointer-events-none data-[highlighted]:bg-neutral-100 data-[highlighted]:text-neutral-900 data-[disabled]:opacity-50"
											>
												<span className="absolute right-2 flex h-3.5 w-3.5 items-center justify-center">
													<SelectPrimitive.ItemIndicator>
														<Check className="h-4 w-4 text-blue-600" />
													</SelectPrimitive.ItemIndicator>
												</span>
												<SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
											</SelectPrimitive.Item>
										))}
									</SelectPrimitive.Group>
								))}
							</SelectPrimitive.Viewport>
							<SelectPrimitive.ScrollDownButton className="flex cursor-default items-center justify-center py-1 text-neutral-500">
								<ChevronDown className="h-4 w-4" />
							</SelectPrimitive.ScrollDownButton>
						</SelectPrimitive.Content>
					</SelectPrimitive.Portal>
				</SelectPrimitive.Root>
				{(name !== undefined || required) && (
					<select
						aria-hidden="true"
						tabIndex={-1}
						name={name}
						required={required}
						disabled={disabled}
						value={formValue}
						onChange={() => undefined}
						// Form validation focuses an invalid control; the trigger is the one people can use.
						onFocus={() => triggerRef.current?.focus()}
						className="pointer-events-none absolute inset-0 h-full w-full opacity-0"
					>
						{options.map((option) => (
							<option key={option.value} value={option.value}>
								{option.text}
							</option>
						))}
					</select>
				)}
			</span>
		);
	},
);
Select.displayName = "Select";

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "@/lib/utils";

/** A bordered card of rows separated by rules, like the Zero look's settings lists. */
export function List({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
	return (
		<div
			className={cn(
				"divide-y divide-neutral-200 overflow-hidden rounded-xl border border-neutral-200 bg-white max-md:rounded-none max-md:border-x-0",
				className,
			)}
			{...props}
		/>
	);
}

export interface ListRowProps extends React.HTMLAttributes<HTMLElement> {
	asChild?: boolean;
}

export function ListRow({ className, asChild = false, ...props }: ListRowProps) {
	const Comp: React.ElementType = asChild ? Slot : "div";
	return (
		<Comp
			className={cn(
				"flex items-center gap-4 bg-white px-4 py-3.5 [&:is(a)]:transition-colors [&:is(a)]:hover:bg-neutral-50",
				className,
			)}
			{...props}
		/>
	);
}

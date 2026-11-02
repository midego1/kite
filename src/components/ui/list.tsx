import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "@/lib/utils";

export interface ListProps extends React.HTMLAttributes<HTMLElement> {
	/** Renders the child element (a `ul`) as the list itself. */
	asChild?: boolean;
}

/** A bordered card of rows separated by rules, like the Zero look's settings lists. */
export function List({ className, asChild = false, ...props }: ListProps) {
	const Comp: React.ElementType = asChild ? Slot : "div";
	return (
		<Comp
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

/** A row's name, with its badge (a role, a status) beside it: Admin → Accounts and Settings → Connected accounts. */
export function ListRowTitle({
	children,
	badge,
	className,
}: {
	children: React.ReactNode;
	badge?: React.ReactNode;
	className?: string;
}) {
	return (
		<span className={cn("flex min-w-0 flex-wrap items-center gap-2", className)}>
			<span className="truncate text-sm font-medium text-neutral-900">{children}</span>
			{badge}
		</span>
	);
}

/** The line under a row's name: the address, the provider, where the mail goes. */
export function ListRowDetail({ children, className }: { children: React.ReactNode; className?: string }) {
	return <span className={cn("block truncate text-xs text-neutral-500", className)}>{children}</span>;
}

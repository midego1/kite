"use client";

// Ported from the shadcn/ui new-york Command (MIT, see NOTICE): cmdk in a Radix dialog, restyled with
// Kite's palette. The dialog is named by `title`, which screen readers announce when it opens.
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Command as CommandPrimitive } from "cmdk";
import { Search } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";
import { useReturnFocus } from "./use-return-focus";

export function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
	return (
		<CommandPrimitive
			className={cn("flex h-full w-full flex-col overflow-hidden bg-white text-neutral-900", className)}
			{...props}
		/>
	);
}

export function CommandDialog({
	title,
	open,
	onOpenChange,
	onEscapeKeyDown,
	className,
	children,
}: {
	title: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onEscapeKeyDown?: (event: KeyboardEvent) => void;
	className?: string;
	children: React.ReactNode;
}) {
	const returnFocus = useReturnFocus();
	return (
		<DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
			<DialogPrimitive.Portal>
				<DialogPrimitive.Overlay className="dialog-overlay fixed inset-0 z-50 bg-neutral-900/40 backdrop-blur-xs" />
				<DialogPrimitive.Content
					aria-describedby={undefined}
					onEscapeKeyDown={onEscapeKeyDown}
					{...returnFocus}
					className={cn(
						"dialog-content fixed left-1/2 top-24 z-50 flex w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-2xl focus:outline-none",
						className,
					)}
				>
					<DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
					{children}
				</DialogPrimitive.Content>
			</DialogPrimitive.Portal>
		</DialogPrimitive.Root>
	);
}

export function CommandInput({ className, children, ...props }: React.ComponentProps<typeof CommandPrimitive.Input>) {
	return (
		<div className="flex items-center gap-3 border-b border-neutral-100 px-4 py-3.5">
			<Search className="h-5 w-5 shrink-0 text-neutral-400" aria-hidden="true" />
			<CommandPrimitive.Input
				className={cn(
					"w-full bg-transparent text-[15px] text-neutral-900 placeholder-neutral-400 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50",
					className,
				)}
				{...props}
			/>
			{children}
		</div>
	);
}

export function CommandList({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>) {
	return (
		<CommandPrimitive.List
			className={cn("max-h-80 overflow-y-auto overflow-x-hidden p-2 outline-none", className)}
			{...props}
		/>
	);
}

export function CommandGroup({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Group>) {
	return (
		<CommandPrimitive.Group
			className={cn(
				"mb-2 last:mb-0 [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-neutral-500",
				className,
			)}
			{...props}
		/>
	);
}

// No colour transition: cmdk marks the first row active just after it mounts, and a fade would show it
// half-highlighted, below the contrast the highlighted row needs.
export function CommandItem({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Item>) {
	return (
		<CommandPrimitive.Item
			className={cn(
				"group/command-item flex cursor-pointer items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-neutral-800 outline-none data-[disabled=true]:pointer-events-none data-[selected=true]:bg-blue-600 data-[selected=true]:text-white data-[disabled=true]:opacity-50",
				className,
			)}
			{...props}
		/>
	);
}

export function CommandShortcut({ className, ...props }: React.HTMLAttributes<HTMLElement>) {
	return (
		<kbd
			className={cn(
				"shrink-0 rounded-md border border-neutral-200 bg-neutral-100 px-2 py-0.5 font-mono text-xs font-medium text-neutral-500 group-data-[selected=true]/command-item:border-transparent group-data-[selected=true]/command-item:bg-blue-700 group-data-[selected=true]/command-item:text-white",
				className,
			)}
			{...props}
		/>
	);
}

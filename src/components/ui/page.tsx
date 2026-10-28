import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { CARD_CLASS } from "./page-utils";

/** A page's title, the line under it and its actions (the primary "New ..." button, for instance). */
export function PageHeader({
	title,
	description,
	actions,
	className,
}: {
	title: ReactNode;
	description?: ReactNode;
	actions?: ReactNode;
	className?: string;
}) {
	return (
		<div className={cn("flex flex-wrap items-start justify-between gap-x-4 gap-y-3", className)}>
			<div className="min-w-0 flex-1">
				<h1 className="text-xl font-semibold tracking-tight text-neutral-900">{title}</h1>
				{description && <p className="mt-1 text-sm text-neutral-500">{description}</p>}
			</div>
			{actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
		</div>
	);
}

/** A titled group of settings on a page: a muted heading and line, then its cards. */
export function PageSection({
	title,
	description,
	actions,
	children,
	className,
}: {
	title: ReactNode;
	description?: ReactNode;
	actions?: ReactNode;
	children: ReactNode;
	className?: string;
}) {
	return (
		<section className={cn("space-y-3", className)}>
			<div className="flex flex-wrap items-end justify-between gap-3">
				<div className="min-w-0">
					<h2 className="text-base font-semibold text-neutral-900">{title}</h2>
					{description && <p className="mt-0.5 text-sm text-neutral-500">{description}</p>}
				</div>
				{actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
			</div>
			{children}
		</section>
	);
}

/** A bordered card whose parts are separated by rules, like Zero's settings cards. */
export function SettingsCard({ children, className }: { children: ReactNode; className?: string }) {
	return <div className={cn(CARD_CLASS, "divide-y divide-neutral-200", className)}>{children}</div>;
}

/** One part of a `SettingsCard`: a small heading and line, then the controls. */
export function SettingsCardSection({
	title,
	description,
	children,
}: {
	title: ReactNode;
	description?: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="p-5">
			<div className="mb-4">
				<h3 className="text-sm font-semibold text-neutral-900">{title}</h3>
				{description && <p className="mt-0.5 text-sm text-neutral-500">{description}</p>}
			</div>
			{children}
		</div>
	);
}

/** What a list shows before it has anything in it. */
export function EmptyState({
	icon: Icon,
	title,
	description,
	action,
	className,
}: {
	icon?: LucideIcon;
	title: ReactNode;
	description?: ReactNode;
	action?: ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"flex flex-col items-center rounded-xl border border-dashed border-neutral-300 px-6 py-10 text-center",
				className,
			)}
		>
			{Icon && (
				<span className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg border border-neutral-200 bg-[#f6f8fc] text-neutral-500">
					<Icon className="h-5 w-5" aria-hidden="true" />
				</span>
			)}
			<p className="text-sm font-medium text-neutral-900">{title}</p>
			{description && <p className="mt-1 max-w-sm text-sm text-neutral-500">{description}</p>}
			{action && <div className="mt-4">{action}</div>}
		</div>
	);
}

/** Actions that cannot be undone, fenced off in red at the end of a page. */
export function DangerZone({
	title = "Danger zone",
	description,
	children,
	className,
}: {
	title?: ReactNode;
	description?: ReactNode;
	children: ReactNode;
	className?: string;
}) {
	return (
		<section className={cn("rounded-xl border border-red-200 p-5 dark:border-red-900/60", className)}>
			<h2 className="text-sm font-semibold text-red-700 dark:text-red-400">{title}</h2>
			{description && <p className="mt-0.5 text-sm text-neutral-500">{description}</p>}
			<div className="mt-4">{children}</div>
		</section>
	);
}

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { CARD_CLASS, FIELD_HINT_CLASS, SETTING_ROW_CLASS } from "./page-utils";

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

/**
 * The top bar of a page that fills one panel (For you, Money Watch, Drive): the title and the page's actions in
 * a 56 px bar, the height of the inbox list and reader headers. It stays put while the page scrolls.
 */
export function PanelHeader({
	title,
	icon: Icon,
	actions,
	className,
}: {
	title: ReactNode;
	icon?: LucideIcon;
	actions?: ReactNode;
	className?: string;
}) {
	return (
		<header
			data-panel-header
			className={cn(
				"sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b border-neutral-200 bg-white px-4 max-md:px-3",
				className,
			)}
		>
			{/* The accent: near-black (white in dark mode) in Kite, blue or indigo in Classic and Kite classic. */}
			{Icon && <Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-blue-600" />}
			<h1 className="min-w-0 flex-1 truncate text-base font-medium text-neutral-900">{title}</h1>
			{actions && <div className="flex min-w-0 shrink items-center justify-end gap-2">{actions}</div>}
		</header>
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
		<div className="p-4 md:p-5">
			<div className="mb-3">
				<h3 className="text-sm font-semibold text-neutral-900">{title}</h3>
				{description && <p className="mt-0.5 text-sm text-neutral-500">{description}</p>}
			</div>
			{children}
		</div>
	);
}

/**
 * One setting: its name and line on the left, the switch or select on the right, on the muted fill. The row is a
 * `label`, so clicking the text reaches the control; give the control its own `aria-label` when the name should be
 * shorter than the text. `children` render under the row, full width (an error, or the fields a switch reveals).
 */
export function SettingRow({
	label,
	description,
	control,
	htmlFor,
	children,
	className,
}: {
	label: ReactNode;
	description?: ReactNode;
	control: ReactNode;
	/** Ties the text to a control that is not inside the row (a native input elsewhere). */
	htmlFor?: string;
	children?: ReactNode;
	className?: string;
}) {
	const Row = htmlFor === undefined ? "label" : "div";
	const Text = htmlFor === undefined ? "span" : "label";
	return (
		<div className={className}>
			<Row className={SETTING_ROW_CLASS}>
				<Text htmlFor={htmlFor} className="min-w-0 flex-1">
					<span className="block text-sm font-medium text-neutral-900">{label}</span>
					{description && <span className="mt-0.5 block text-sm text-neutral-500">{description}</span>}
				</Text>
				<span className="flex shrink-0 items-center self-center">{control}</span>
			</Row>
			{children}
		</div>
	);
}

/** Rows of settings inside a card section, one under the other. */
export function SettingRows({ children, className }: { children: ReactNode; className?: string }) {
	return <div className={cn("space-y-2", className)}>{children}</div>;
}

/**
 * A form's last line: its buttons, then the result as a status message (`role="status"`, so it is announced), or
 * a note on why the form is read-only.
 */
export function FormFooter({
	children,
	status,
	note,
	className,
}: {
	children: ReactNode;
	status?: ReactNode;
	note?: ReactNode;
	className?: string;
}) {
	return (
		<div className={cn("flex flex-wrap items-center gap-x-3 gap-y-2", className)}>
			{children}
			{note && <p className="text-sm text-neutral-500">{note}</p>}
			{status && (
				<p role="status" className="text-sm text-neutral-500">
					{status}
				</p>
			)}
		</div>
	);
}

/** The line under a field explaining what it takes. */
export function FieldHint({ children, className, id }: { children: ReactNode; className?: string; id?: string }) {
	return (
		<p id={id} className={cn(FIELD_HINT_CLASS, className)}>
			{children}
		</p>
	);
}

/** A failure under a form or a row, announced at once. */
export function FormError({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<p role="alert" className={cn("text-sm text-red-600", className)}>
			{children}
		</p>
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

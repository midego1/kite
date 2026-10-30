import Link from "next/link";
import type { DragEvent, MouseEvent } from "react";
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";
import { usePathname, useRouter } from "next/navigation";
import { getMessageDragData } from "@/lib/messages/drag-utils";
import { useKeyChanged } from "@/hooks/use-synced-state";
import { useSelectedMailbox } from "./mailbox-provider";
import { useSidebar } from "./sidebar-state";
import { useCompose } from "./compose/compose-context";
import { Tooltip } from "./ui/tooltip";
import { preloadMailboxPage } from "./components-nav-utils";
import type { NavLink } from "./components-nav-types";
import {
	RAIL_BADGE_CLASS,
	RAIL_ICON_SIZE,
	RAIL_ITEM_CLASS,
	RAIL_TOOLTIP_CLASS,
	railBadgeLabel,
	railIconColor,
} from "./sidebar-rail-utils";

type Props = {
	link: NavLink;
	iconClassName?: string;
	labelClassName?: string;
	wrap?: boolean;
};
export function NavItem({ link, iconClassName, labelClassName, wrap }: Props) {
	const pathname = usePathname();
	const router = useRouter();
	const { openComposer } = useCompose();
	const { mailboxScope } = useSelectedMailbox();
	const { minimal } = useSidebar();
	const [dragOver, setDragOver] = useState(false);
	const [navigationProgress, setNavigationProgress] = useState<number | null>(null);

	// Only a route change completes the bar.
	if (useKeyChanged(pathname) && navigationProgress !== null) setNavigationProgress(100);

	useEffect(() => {
		if (navigationProgress !== 100) return;
		const timer = window.setTimeout(() => setNavigationProgress(null), 220);
		return () => window.clearTimeout(timer);
	}, [navigationProgress]);

	useEffect(() => {
		if (navigationProgress === null || navigationProgress >= 90) return;
		const timer = window.setTimeout(() => {
			setNavigationProgress((current) => (current === null || current >= 100 ? current : Math.min(90, current + 8)));
		}, 80);
		return () => window.clearTimeout(timer);
	}, [navigationProgress]);

	if (!link.href) {
		return <span className="flex-1" />;
	}

	const Icon = link.icon;
	if (!Icon) return null;
	const active = pathname === link.href || pathname.startsWith(`${link.href}/`);
	const classes = cn(
		"flex h-9 items-center gap-3 rounded-lg text-sm text-neutral-700 transition-colors",
		// The rail keeps its 40px squares on a narrow window; only the phone sheet (never minimal) grows its rows.
		minimal ? RAIL_ITEM_CLASS : "max-md:min-h-11 max-md:text-base",
		active ? "bg-blue-100 text-blue-900 font-medium" : "hover:bg-neutral-200/60 hover:text-neutral-900",
		dragOver && "bg-blue-50 text-blue-900 ring-1 ring-blue-200",
		// Zero's "New email": a full-width muted button rather than a coloured slab.
		link.primary &&
			"mb-2 h-9 justify-center rounded-lg border border-neutral-200 bg-neutral-100 px-3 font-medium text-neutral-900 hover:bg-neutral-200",
		link.primary && minimal && "mb-0 h-10 w-10 rounded-xl px-0",
		wrap && !minimal && "h-auto min-h-9 items-start py-2",
	);
	const dropProps = link.onMessageDrop
		? {
				onDragOver: (event: DragEvent) => {
					event.preventDefault();
					event.dataTransfer.dropEffect = "move";
					setDragOver(true);
				},
				onDragLeave: () => setDragOver(false),
				onDrop: (event: DragEvent) => {
					const payload = getMessageDragData(event.dataTransfer);
					setDragOver(false);
					if (!payload) return;
					event.preventDefault();
					link.onMessageDrop?.(payload.messageIds);
				},
			}
		: {};

	if (link.href === "/compose") {
		const composeButton = (
			<button
				type="button"
				onClick={openComposer}
				className={cn(!minimal && "ml-3", classes)}
				// "Compose" stays in the name, which is what the shortcut help, tests and screen reader users know.
				aria-label={`Compose ${(link.label ?? "").toLowerCase()}`}
				{...dropProps}
			>
				<Icon
					size={minimal ? RAIL_ICON_SIZE : 16}
					style={{ color: minimal ? undefined : link.iconColor }}
					className={iconClassName}
				/>
				{!minimal && <span>{link.label}</span>}
				{!minimal && typeof link.count === "number" && link.count > 0 && (
					<span className="ml-auto mr-1 text-xs font-medium tabular-nums text-neutral-500">
						{link.count > 99 ? "99+" : link.count}
					</span>
				)}
				{minimal && typeof link.count === "number" && link.count > 0 && (
					<span className={RAIL_BADGE_CLASS}>{railBadgeLabel(link.count)}</span>
				)}
			</button>
		);
		return minimal && link.label ? (
			<Tooltip label={link.label} placement="right" className={RAIL_TOOLTIP_CLASS}>
				{composeButton}
			</Tooltip>
		) : (
			composeButton
		);
	}

	// Intent (hover, focus, press) warms the route and its first page of mail, so
	// the click itself navigates immediately and usually renders from cache.
	function preload() {
		if (!link.preloadMessages || active) return;
		// Both calls are no-ops when the route or list is already cached.
		router.prefetch(link.href!);
		void preloadMailboxPage(link.href!, mailboxScope ?? undefined).catch(() => undefined);
	}

	function navigate(event: MouseEvent<HTMLAnchorElement>) {
		if (!link.preloadMessages || active || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
		preload();
		setNavigationProgress(12);
		// The bar is cosmetic; never leave it hanging if the route change fails.
		window.setTimeout(
			() => setNavigationProgress((current) => (current !== null && current < 100 ? null : current)),
			5_000,
		);
	}

	const navLink = (
		<Link
			href={link.href}
			onClick={navigate}
			onPointerEnter={preload}
			onPointerDown={preload}
			onFocus={preload}
			aria-label={minimal ? link.label : undefined}
			className={cn(!minimal && "ml-3 px-3", classes)}
			{...dropProps}
		>
			<Icon
				// className={minimal ? "h-4 w-4" : "h-5 w-5"}
				style={{ color: minimal ? railIconColor(link.iconColor) : link.iconColor }}
				size={minimal ? RAIL_ICON_SIZE : 16}
				className={cn(!minimal && "max-md:h-5 max-md:w-5", wrap && !minimal && "mt-0.5 shrink-0", iconClassName)}
			/>
			{!minimal && (
				<span
					className={cn(
						"flex-1",
						wrap && "min-w-0 break-words leading-5 max-md:leading-6",
						labelClassName,
						typeof link.count === "number" && link.count > 0 && "font-medium text-neutral-900",
					)}
				>
					{link.label}
				</span>
			)}
			{!minimal && typeof link.count === "number" && link.count > 0 && (
				<span
					className={cn(
						// Counts are right-aligned and muted, as in Zero's sidebar.
						"ml-auto mr-0.5 text-xs font-medium tabular-nums text-neutral-500",
						wrap && "shrink-0 leading-5",
					)}
				>
					{link.count > 99 ? "99+" : link.count}
				</span>
			)}
			{minimal && typeof link.count === "number" && link.count > 0 && (
				<span className={RAIL_BADGE_CLASS}>{railBadgeLabel(link.count)}</span>
			)}
		</Link>
	);

	return (
		<>
			{navigationProgress !== null && (
				<div className="fixed inset-x-0 top-0 z-[120] h-1 bg-blue-100">
					<div
						className="h-full bg-blue-600 transition-[width] duration-100 ease-out"
						style={{ width: `${navigationProgress}%` }}
					/>
				</div>
			)}
			{minimal && link.label ? (
				<Tooltip label={link.label} placement="right" className={RAIL_TOOLTIP_CLASS}>
					{navLink}
				</Tooltip>
			) : (
				navLink
			)}
		</>
	);
}

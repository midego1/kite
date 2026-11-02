"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import { Clock, HardDrive, Paperclip, Trash2, UsersRound, type LucideIcon } from "lucide-react";
import { SectionNavSheet } from "@/components/section-nav-sheet";
import { SECTION_PANEL_CLASS } from "@/components/settings/section-nav-utils";
import { formatDriveSize } from "@/lib/drive/name-utils";
import type { DriveUsage } from "@/lib/drive/types";
import { DRIVE_USAGE_EVENT, DRIVE_VIEW_TITLES, usagePercent } from "./drive-utils";

const LINKS: { href: string; label: string; icon: LucideIcon; match: (path: string) => boolean }[] = [
	{
		href: "/drive",
		label: DRIVE_VIEW_TITLES.my,
		icon: HardDrive,
		match: (path) => path === "/drive" || path.startsWith("/drive/f/"),
	},
	{ href: "/drive/recent", label: DRIVE_VIEW_TITLES.recent, icon: Clock, match: (path) => path === "/drive/recent" },
	{
		href: "/drive/shared",
		label: DRIVE_VIEW_TITLES.shared,
		icon: UsersRound,
		match: (path) => path === "/drive/shared",
	},
	{
		href: "/drive/attachments",
		label: DRIVE_VIEW_TITLES.attachments,
		icon: Paperclip,
		match: (path) => path === "/drive/attachments",
	},
	{ href: "/drive/trash", label: DRIVE_VIEW_TITLES.trash, icon: Trash2, match: (path) => path === "/drive/trash" },
];

function UsageBar({ usage }: { usage: DriveUsage }) {
	if (!usage.limit) return <p className="text-xs text-neutral-500">{formatDriveSize(usage.used)} used</p>;
	const percent = usagePercent(usage.used, usage.limit);
	return (
		<div data-drive-usage>
			<div
				role="progressbar"
				aria-label="Drive storage used"
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={percent}
				className="mb-1.5 h-1.5 overflow-hidden rounded-full bg-neutral-200"
			>
				<div
					className={clsx("h-full rounded-full transition-[width]", percent >= 90 ? "bg-red-500" : "bg-blue-500")}
					style={{ width: `${percent}%` }}
				/>
			</div>
			<p className="text-xs text-neutral-500">
				{formatDriveSize(usage.used)} of {formatDriveSize(usage.limit)} used
			</p>
		</div>
	);
}

/**
 * The Drive views (My Drive, Recent, Shared with me, All attachments, Trash) as the menu panel beside the listing,
 * drawn like the Settings menu beside its page: a bordered column from `md` up, a bottom sheet behind a pill on
 * phones. The storage used sits at its foot. The mail menu stays in the sidebar, where it is on every page.
 */
function DriveNav() {
	const pathname = usePathname();
	const [usage, setUsage] = useState<DriveUsage | null>(null);
	const current = LINKS.find((link) => link.match(pathname));

	useEffect(() => {
		const onUsage = (event: Event) => setUsage((event as CustomEvent<DriveUsage>).detail);
		window.addEventListener(DRIVE_USAGE_EVENT, onUsage);
		return () => window.removeEventListener(DRIVE_USAGE_EVENT, onUsage);
	}, []);

	return (
		<SectionNavSheet
			title="Drive menu"
			label={current?.label ?? "Drive"}
			className={clsx("w-full md:flex md:min-h-0 md:w-64 md:shrink-0 md:flex-col", SECTION_PANEL_CLASS)}
		>
			<div className="flex h-14 shrink-0 items-center gap-2 border-b border-neutral-200 px-4">
				<HardDrive aria-hidden="true" className="h-4 w-4 shrink-0 text-blue-600" />
				<h2 className="min-w-0 truncate text-base font-medium text-neutral-900">Drive</h2>
			</div>
			<nav
				aria-label="Drive views"
				className="flex flex-col gap-px px-2 pt-3 pb-4 md:min-h-0 md:flex-1 md:overflow-y-auto md:overscroll-contain"
			>
				{LINKS.map(({ href, label, icon: Icon, match }) => {
					const active = match(pathname);
					return (
						<Link
							key={href}
							href={href}
							aria-current={active ? "page" : undefined}
							className={clsx(
								"flex h-9 items-center gap-3 rounded-lg px-3 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 max-md:min-h-11 max-md:text-base",
								active
									? "bg-blue-100 font-medium text-blue-900"
									: "text-neutral-700 hover:bg-neutral-100 hover:text-neutral-900",
							)}
						>
							<Icon className={clsx("h-4 w-4 shrink-0", active ? "text-neutral-900" : "text-neutral-500")} />
							{label}
						</Link>
					);
				})}
			</nav>
			{usage && (
				<div className="shrink-0 border-t border-neutral-200 px-4 py-3">
					<UsageBar usage={usage} />
				</div>
			)}
		</SectionNavSheet>
	);
}

/** The Drive pages' two panels: the views menu at the left, the listing at the right, on the page background. */
export function DrivePanels({ children }: { children: ReactNode }) {
	return (
		<div data-page-panels className="flex h-full min-h-0 flex-col bg-inherit md:flex-row md:gap-2">
			<DriveNav />
			<section className={clsx("flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-white", SECTION_PANEL_CLASS)}>
				{children}
			</section>
		</div>
	);
}

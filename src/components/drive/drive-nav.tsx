"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
	Clock,
	FolderPlus,
	FolderUp,
	HardDrive,
	Inbox,
	Paperclip,
	Plus,
	Trash2,
	Upload,
	UsersRound,
	type LucideIcon,
} from "lucide-react";
import { SidebarFooter } from "@/components/sidebar-footer";
import { DashboardNotices } from "@/components/dashboard-notices";
import { MailboxSelector } from "@/components/mailbox-selector";
import { NavSectionLabel } from "@/components/nav-section-header";
import { SidebarAccounts } from "@/components/sidebar-accounts";
import { RAIL_ICON_SIZE, RAIL_ITEM_CLASS } from "@/components/sidebar-rail-utils";
import { SidebarScaffold } from "@/components/sidebar-scaffold";
import { useSidebar } from "@/components/sidebar-state";
import { formatDriveSize } from "@/lib/drive/name-utils";
import type { DriveUsage } from "@/lib/drive/types";
import {
	DRIVE_COMMAND_EVENT,
	DRIVE_USAGE_EVENT,
	DRIVE_VIEW_TITLES,
	usagePercent,
	type DriveCommand,
} from "./drive-utils";

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

const menuItemClass =
	"flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-neutral-700 outline-none data-[highlighted]:bg-neutral-100 data-[highlighted]:text-neutral-900";

function sendCommand(command: DriveCommand) {
	window.dispatchEvent(new CustomEvent(DRIVE_COMMAND_EVENT, { detail: command }));
}

function NewMenu({ compact }: { compact: boolean }) {
	return (
		<DropdownMenu.Root>
			<DropdownMenu.Trigger asChild>
				<button
					type="button"
					aria-label="New"
					// Zero's "New email": a full-width muted button rather than a floating card.
					className={clsx(
						"flex items-center justify-center gap-2 border border-neutral-200 bg-neutral-100 text-sm font-medium text-neutral-900 transition-colors hover:bg-neutral-200",
						compact ? RAIL_ITEM_CLASS : "mb-2 ml-3 h-9 w-[calc(100%-0.75rem)] rounded-lg px-3 max-md:min-h-11",
					)}
				>
					<Plus size={compact ? RAIL_ICON_SIZE : 16} />
					{!compact && "New"}
				</button>
			</DropdownMenu.Trigger>
			<DropdownMenu.Portal>
				<DropdownMenu.Content
					align="start"
					sideOffset={6}
					className="z-[200] min-w-52 rounded-xl border border-neutral-200 bg-white p-1 shadow-lg"
				>
					<DropdownMenu.Item className={menuItemClass} onSelect={() => sendCommand("new-folder")}>
						<FolderPlus size={16} />
						New folder
					</DropdownMenu.Item>
					<DropdownMenu.Separator className="-mx-1 my-1 h-px bg-neutral-200" />
					<DropdownMenu.Item className={menuItemClass} onSelect={() => sendCommand("upload-files")}>
						<Upload size={16} />
						Upload files
					</DropdownMenu.Item>
					<DropdownMenu.Item className={menuItemClass} onSelect={() => sendCommand("upload-folder")}>
						<FolderUp size={16} />
						Upload folder
					</DropdownMenu.Item>
				</DropdownMenu.Content>
			</DropdownMenu.Portal>
		</DropdownMenu.Root>
	);
}

function UsageBar({ usage }: { usage: DriveUsage | null }) {
	if (!usage) return null;
	if (!usage.limit) return <p className="px-3 pb-2 text-xs text-neutral-600">{formatDriveSize(usage.used)} used</p>;
	const percent = usagePercent(usage.used, usage.limit);
	return (
		<div className="px-3 pb-2" data-drive-usage>
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
			<p className="text-xs text-neutral-600">
				{formatDriveSize(usage.used)} of {formatDriveSize(usage.limit)} used
			</p>
		</div>
	);
}

function DriveNavLink({
	href,
	label,
	icon: Icon,
	active,
	compact,
	onClick,
}: {
	href: string;
	label: string;
	icon: LucideIcon;
	active: boolean;
	compact: boolean;
	onClick?: () => void;
}) {
	return (
		<Link
			href={href}
			onClick={onClick}
			aria-current={active ? "page" : undefined}
			aria-label={compact ? label : undefined}
			title={compact ? label : undefined}
			className={clsx(
				"flex items-center gap-3 text-sm text-neutral-700 transition-colors",
				compact ? RAIL_ITEM_CLASS : "ml-3 h-9 rounded-lg px-3 max-md:min-h-11 max-md:text-base",
				active ? "bg-blue-100 font-medium text-blue-900" : "hover:bg-neutral-200/60 hover:text-neutral-900",
			)}
		>
			<Icon size={compact ? RAIL_ICON_SIZE : 16} className="shrink-0" />
			{!compact && <span className="truncate">{label}</span>}
		</Link>
	);
}

/** The Drive sidebar: the New menu, a way back to the mail, the views, and the storage you have used. */
export function DriveNav() {
	const { minimal, mobile, toggle } = useSidebar();
	const pathname = usePathname();
	const [usage, setUsage] = useState<DriveUsage | null>(null);
	const compact = minimal && !mobile;

	useEffect(() => {
		const onUsage = (event: Event) => setUsage((event as CustomEvent<DriveUsage>).detail);
		window.addEventListener(DRIVE_USAGE_EVENT, onUsage);
		return () => window.removeEventListener(DRIVE_USAGE_EVENT, onUsage);
	}, []);

	return (
		<SidebarScaffold
			header={<SidebarAccounts />}
			account={<MailboxSelector placement="sidebar" />}
			footer={
				<>
					{!compact && <UsageBar usage={usage} />}
					<SidebarFooter notices={<DashboardNotices slot="sidebar" />} />
				</>
			}
		>
			<NewMenu compact={compact} />
			{/* One click back to the mail, also from the icon rail. */}
			{!compact && <NavSectionLabel label="Mail" />}
			<div aria-label="Mail" role="group" className="space-y-px">
				<DriveNavLink
					href="/inbox"
					label="Inbox"
					icon={Inbox}
					active={false}
					compact={compact}
					onClick={mobile ? toggle : undefined}
				/>
			</div>
			{compact ? <hr className="mx-6 my-2 border-neutral-200/70" /> : <NavSectionLabel label="Drive" />}
			<div aria-label="Drive" role="group" className="space-y-px">
				{LINKS.map(({ href, label, icon, match }) => (
					<DriveNavLink
						key={href}
						href={href}
						label={label}
						icon={icon}
						active={match(pathname)}
						compact={compact}
						onClick={mobile ? toggle : undefined}
					/>
				))}
			</div>
		</SidebarScaffold>
	);
}

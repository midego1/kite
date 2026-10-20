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
	Paperclip,
	Plus,
	Trash2,
	Upload,
	UsersRound,
	type LucideIcon,
} from "lucide-react";
import { SidebarFooter } from "@/components/sidebar-footer";
import { SidebarHeader } from "@/components/sidebar-header";
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
	"flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm text-neutral-700 outline-none data-[highlighted]:bg-neutral-100";

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
					className={clsx(
						"mb-3 flex h-12 items-center gap-3 rounded-2xl bg-white text-sm font-medium text-neutral-800 shadow-sm ring-1 ring-neutral-200 transition-shadow hover:shadow-md",
						compact ? "mx-auto w-12 justify-center" : "ml-3 w-fit px-5",
					)}
				>
					<Plus size={20} />
					{!compact && "New"}
				</button>
			</DropdownMenu.Trigger>
			<DropdownMenu.Portal>
				<DropdownMenu.Content
					align="start"
					sideOffset={6}
					className="z-[200] min-w-52 rounded-xl border border-neutral-200 bg-white p-1.5 shadow-xl"
				>
					<DropdownMenu.Item className={menuItemClass} onSelect={() => sendCommand("new-folder")}>
						<FolderPlus size={18} />
						New folder
					</DropdownMenu.Item>
					<DropdownMenu.Separator className="my-1 h-px bg-neutral-100" />
					<DropdownMenu.Item className={menuItemClass} onSelect={() => sendCommand("upload-files")}>
						<Upload size={18} />
						Upload files
					</DropdownMenu.Item>
					<DropdownMenu.Item className={menuItemClass} onSelect={() => sendCommand("upload-folder")}>
						<FolderUp size={18} />
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
					className={clsx("h-full rounded-full transition-[width]", percent >= 90 ? "bg-red-500" : "bg-blue-600")}
					style={{ width: `${percent}%` }}
				/>
			</div>
			<p className="text-xs text-neutral-600">
				{formatDriveSize(usage.used)} of {formatDriveSize(usage.limit)} used
			</p>
		</div>
	);
}

/** The Drive sidebar: the New menu, the views, and the storage you have used. */
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
			header={<SidebarHeader href="/inbox" />}
			footer={
				<>
					{!compact && <UsageBar usage={usage} />}
					<SidebarFooter />
				</>
			}
		>
			<NewMenu compact={compact} />
			<div aria-label="Drive" role="group" className="space-y-px">
				{LINKS.map(({ href, label, icon: Icon, match }) => {
					const active = match(pathname);
					return (
						<Link
							key={href}
							href={href}
							onClick={mobile ? toggle : undefined}
							aria-current={active ? "page" : undefined}
							title={compact ? label : undefined}
							className={clsx(
								"flex h-9 items-center gap-3 rounded-lg text-sm text-neutral-700 transition-colors max-md:min-h-11 max-md:text-base",
								compact ? "mx-auto w-10 justify-center rounded-full" : "rounded-l-none rounded-r-full pl-6 pr-3",
								active ? "bg-blue-100 font-semibold text-blue-900" : "hover:bg-neutral-200/60",
							)}
						>
							<Icon size={16} className="shrink-0" />
							{!compact && <span className="truncate">{label}</span>}
						</Link>
					);
				})}
			</div>
		</SidebarScaffold>
	);
}

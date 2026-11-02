"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { NavItem } from "@/components/components-nav";
import type { CustomFolder } from "@/components/dashboard-nav-types";
import { customFolderNavLink } from "@/components/dashboard-nav-utils";
import { useSidebar } from "@/components/sidebar-state";
import { cn } from "@/lib/utils";
import { DeleteFolderDialog, RenameFolderDialog } from "./folder-dialogs";

const ITEM_CLASS =
	"flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm text-neutral-700 outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-neutral-100";

/**
 * A user folder's sidebar row with its Rename and Delete menu: the "⋯" button on hover or focus, a right-click or
 * the keyboard's context-menu key anywhere on the row. In the collapsed rail there is no room for the button, so the
 * menu opens from the row's icon. Without full access to the mailbox the row is a plain link.
 */
export function FolderNavItem({
	folder,
	unread,
	canManage,
}: {
	folder: CustomFolder;
	unread: number | undefined;
	canManage: boolean;
}) {
	const { minimal } = useSidebar();
	const pathname = usePathname();
	const router = useRouter();
	const [menuOpen, setMenuOpen] = useState(false);
	const [renaming, setRenaming] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const row = <NavItem wrap link={customFolderNavLink(folder, unread)} />;
	if (!canManage) return row;

	return (
		<DropdownMenu.Root modal={false} open={menuOpen} onOpenChange={setMenuOpen}>
			<div
				className="group/folder relative"
				data-folder-row={folder.id}
				onContextMenu={(event) => {
					event.preventDefault();
					setMenuOpen(true);
				}}
			>
				{row}
				<DropdownMenu.Trigger asChild>
					<button
						type="button"
						aria-label={`Folder options for ${folder.name}`}
						tabIndex={minimal ? -1 : 0}
						className={
							minimal
								? "pointer-events-none absolute inset-0 opacity-0"
								: "absolute right-1 top-1.5 flex h-6 w-6 items-center justify-center rounded-md bg-neutral-100 text-neutral-600 opacity-0 transition-opacity hover:bg-neutral-200 hover:text-neutral-900 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 group-hover/folder:opacity-100 data-[state=open]:opacity-100 max-md:top-2.5 max-md:h-7 max-md:w-7"
						}
					>
						<MoreHorizontal aria-hidden className="h-4 w-4" />
					</button>
				</DropdownMenu.Trigger>
			</div>
			<DropdownMenu.Portal>
				<DropdownMenu.Content
					align="start"
					sideOffset={4}
					className="z-[130] min-w-44 rounded-xl border border-neutral-200 bg-white p-1 shadow-lg"
				>
					<DropdownMenu.Item className={ITEM_CLASS} onSelect={() => setRenaming(true)}>
						<Pencil aria-hidden className="h-4 w-4" />
						Rename
					</DropdownMenu.Item>
					<DropdownMenu.Item className={cn(ITEM_CLASS, "text-red-700")} onSelect={() => setDeleting(true)}>
						<Trash2 aria-hidden className="h-4 w-4" />
						Delete
					</DropdownMenu.Item>
				</DropdownMenu.Content>
			</DropdownMenu.Portal>
			<RenameFolderDialog folder={folder} open={renaming} onOpenChange={setRenaming} />
			<DeleteFolderDialog
				folder={folder}
				open={deleting}
				onOpenChange={setDeleting}
				onDeleted={() => {
					// Looking at the folder that just went: its page has nothing left to show.
					if (pathname === `/folders/${folder.id}` || pathname.startsWith(`/folders/${folder.id}/`)) {
						router.push("/inbox");
					}
				}}
			/>
		</DropdownMenu.Root>
	);
}

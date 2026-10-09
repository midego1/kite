"use client";

import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Archive, Clock, FileText, Folder, Inbox, MailPlus, Plus, Send, ShieldAlert, Star, Trash2 } from "lucide-react";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useMessageCounts } from "@/hooks/use-message-counts";
import { authFetch } from "@/lib/auth/client";
import { DEFAULT_FOLDER_COLOR, FOLDER_COLOR_OPTIONS } from "@/lib/folders/colors";
import type { FolderColor } from "@/lib/folders/types";
import { NavItem } from "./components-nav";
import type { NavLink } from "./components-nav-types";
import type { CustomFolder } from "./dashboard-nav-types";
import { getFolderNavCount, moveMessagesToCustomFolder, moveMessagesToSystemFolder } from "./dashboard-nav-utils";
import { NavSectionHeader, useSectionOpen } from "./nav-section-header";
import { ReorderableList } from "./reorderable-list";
import { useStoredState } from "@/hooks/use-stored-state";
import { useKeyChanged } from "@/hooks/use-synced-state";
import { SidebarFooter } from "./sidebar-footer";
import { SidebarHeader } from "./sidebar-header";
import { SidebarScaffold } from "./sidebar-scaffold";
import { SidebarMailboxSwitcher } from "./sidebar-mailbox-switcher";
import { useSidebar } from "./sidebar-state";

const links = [
	{ href: "/compose", label: "Compose", icon: MailPlus, primary: true },
	{ href: "/inbox", label: "Inbox", icon: Inbox, preloadMessages: true },
	{ href: "/starred", label: "Starred", icon: Star, preloadMessages: true },
	{ href: "/snoozed", label: "Snoozed", icon: Clock, preloadMessages: true },
	{ href: "/sent", label: "Sent", icon: Send, preloadMessages: true },
	{ href: "/drafts", label: "Drafts", icon: FileText, preloadMessages: true },
	{
		href: "/archived",
		label: "Archived",
		icon: Archive,
		preloadMessages: true,
	},
	{ href: "/spam", label: "Spam", icon: ShieldAlert, preloadMessages: true },
	{ href: "/trash", label: "Trash", icon: Trash2, preloadMessages: true },
];

// Drafts, Archived, Spam and Trash start tucked under "More...".
const MORE_LINK_HREFS = ["/drafts", "/archived", "/spam", "/trash"];
const MAX_VISIBLE_FOLDERS = 3;
const MORE_OPEN_KEY = "kite:nav:more-open";
const FOLDERS_OPEN_KEY = "kite:nav:folders-open";

function NavToggle({
	expanded,
	onClick,
	collapsedLabel = "More...",
	expandedLabel = "Show less...",
}: {
	expanded: boolean;
	onClick: () => void;
	collapsedLabel?: string;
	expandedLabel?: string;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-expanded={expanded}
			className="ml-3 flex h-9 w-[calc(100%-0.75rem)] items-center rounded-lg pl-10 text-left text-sm text-neutral-500 transition-colors hover:bg-neutral-200/60 hover:text-neutral-800 max-md:min-h-11 max-md:text-base"
		>
			{expanded ? expandedLabel : collapsedLabel}
		</button>
	);
}

export function DashboardNav({ className }: { className?: string }) {
	const { minimal } = useSidebar();
	const pathname = usePathname();
	const [moreOpen, setMoreOpen] = useStoredState(MORE_OPEN_KEY, false);
	const [foldersOpen, setFoldersOpen] = useStoredState(FOLDERS_OPEN_KEY, false);
	const [foldersSectionOpen, toggleFoldersSection] = useSectionOpen("kite:nav:folders-section-open");
	const { selectedMailbox, isLoading } = useSelectedMailbox();
	const { counts } = useMessageCounts(selectedMailbox?.id, !isLoading);
	const [folders, setFolders] = useState<CustomFolder[]>([]);
	const [newFolderName, setNewFolderName] = useState("");
	const [newFolderColor, setNewFolderColor] = useState<FolderColor>(DEFAULT_FOLDER_COLOR);
	const [addingFolder, setAddingFolder] = useState(false);
	const [folderDialogOpen, setFolderDialogOpen] = useState(false);
	const linksWithCounts: NavLink[] = links.map((link): NavLink => {
		if (link.href === "/inbox") {
			return { ...link, count: getFolderNavCount("inbox", counts.folders) };
		}
		if (link.href === "/starred") {
			return { ...link, count: getFolderNavCount("starred", counts.folders) };
		}
		if (link.href === "/snoozed") {
			return { ...link, count: getFolderNavCount("snoozed", counts.folders) };
		}
		if (link.href === "/sent") {
			return { ...link, count: getFolderNavCount("sent", counts.folders) };
		}
		if (link.href === "/drafts") {
			return { ...link, count: getFolderNavCount("drafts", counts.folders) };
		}
		if (link.href === "/archived") {
			return {
				...link,
				count: getFolderNavCount("archived", counts.folders),
				onMessageDrop: (messageIds: string[]) => void moveMessagesToSystemFolder(messageIds, "archive"),
			};
		}
		if (link.href === "/spam") {
			return {
				...link,
				count: getFolderNavCount("spam", counts.folders),
				onMessageDrop: (messageIds: string[]) => void moveMessagesToSystemFolder(messageIds, "spam"),
			};
		}
		if (link.href === "/trash") {
			return {
				...link,
				count: getFolderNavCount("trash", counts.folders),
				onMessageDrop: (messageIds: string[]) => void moveMessagesToSystemFolder(messageIds, "trash"),
			};
		}
		return link;
	});

	function toggleMore() {
		setMoreOpen(!moreOpen);
	}

	function toggleFolders() {
		setFoldersOpen(!foldersOpen);
	}

	const isActiveHref = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
	const composeLink = linksWithCounts.find((link) => link.href === "/compose");
	const mainLinks = linksWithCounts.filter((link) => link.href !== "/compose" && !MORE_LINK_HREFS.includes(link.href!));
	const moreLinks = linksWithCounts.filter((link) => MORE_LINK_HREFS.includes(link.href!));
	// The icon rail has no room for text toggles. When collapsed, the page you are on stays listed on its own.
	const showAllMoreLinks = minimal || moreOpen;
	const foldersOverflow = !minimal && folders.length > MAX_VISIBLE_FOLDERS;

	const selectedMailboxId = selectedMailbox?.id ?? null;
	if (useKeyChanged(selectedMailboxId) && !selectedMailboxId) setFolders([]);

	useEffect(() => {
		if (!selectedMailbox?.id) return;

		let cancelled = false;
		const params = new URLSearchParams({ mailboxId: selectedMailbox.id });
		authFetch(`/api/folders?${params.toString()}`)
			.then((response) => response.json() as Promise<{ folders?: CustomFolder[] }>)
			.then((data) => {
				if (!cancelled) setFolders(data.folders ?? []);
			})
			.catch(() => {
				if (!cancelled) setFolders([]);
			});

		return () => {
			cancelled = true;
		};
	}, [selectedMailbox?.id]);

	async function createFolder(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!selectedMailbox?.id || !newFolderName.trim()) return;

		setAddingFolder(true);
		try {
			const response = await authFetch("/api/folders", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					mailboxId: selectedMailbox.id,
					name: newFolderName,
					color: newFolderColor,
				}),
			});
			if (!response.ok) return;
			const folder = (await response.json()) as CustomFolder;
			setFolders((items) => [...items, folder].sort((a, b) => a.name.localeCompare(b.name)));
			setNewFolderName("");
			setNewFolderColor(DEFAULT_FOLDER_COLOR);
			setFolderDialogOpen(false);
		} finally {
			setAddingFolder(false);
		}
	}

	return (
		<SidebarScaffold className={className} header={<SidebarHeader href="/inbox" />} footer={<SidebarFooter />}>
			<SidebarMailboxSwitcher />
			{composeLink && <NavItem labelClassName="font-medium" link={composeLink} />}
			{minimal && <hr className="mx-6 my-2 border-neutral-200/70" />}
			<ReorderableList
				storageKey="kite:nav:layout"
				enabled={!minimal}
				lists={[
					{ id: "main", items: mainLinks.map((link) => ({ id: link.href!, node: <NavItem link={link} /> })) },
					{
						id: "more",
						before: minimal ? undefined : <NavToggle expanded={moreOpen} onClick={toggleMore} />,
						visibleIds: (ordered) => (showAllMoreLinks ? ordered : ordered.filter((id) => isActiveHref(id))),
						items: moreLinks.map((link) => ({ id: link.href!, node: <NavItem link={link} /> })),
					},
				]}
			/>
			{minimal && <hr className="mx-6 my-2 border-neutral-200/70" />}
			{!minimal && (
				<NavSectionHeader label="Folders" open={foldersSectionOpen} onToggle={toggleFoldersSection}>
					{selectedMailbox && (
						<Dialog open={folderDialogOpen} onOpenChange={setFolderDialogOpen}>
							<DialogTrigger asChild>
								<button
									type="button"
									className="flex h-7 w-7 items-center justify-center rounded-lg text-neutral-500 hover:bg-blue-50 hover:text-blue-700"
									aria-label="Create folder"
								>
									<Plus className="h-4 w-4" />
								</button>
							</DialogTrigger>
							<DialogContent>
								<DialogHeader>
									<DialogTitle>Create folder</DialogTitle>
									<DialogDescription>Add a folder to the selected mailbox.</DialogDescription>
								</DialogHeader>
								<form onSubmit={createFolder} className="space-y-4">
									<div className="space-y-2">
										<Label htmlFor="folderName">Folder name</Label>
										<Input
											id="folderName"
											value={newFolderName}
											onChange={(event) => setNewFolderName(event.target.value)}
											placeholder="Receipts"
											autoFocus
										/>
									</div>
									<div className="space-y-2">
										<Label>Color</Label>
										<div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Folder color">
											{FOLDER_COLOR_OPTIONS.map((option) => (
												<button
													key={option.value}
													type="button"
													role="radio"
													aria-checked={newFolderColor === option.value}
													aria-label={option.label}
													title={option.label}
													onClick={() => setNewFolderColor(option.value)}
													className={`h-8 w-8 rounded-full border-2 transition-transform hover:scale-110 ${
														newFolderColor === option.value
															? "border-neutral-900 ring-2 ring-neutral-300 ring-offset-2"
															: "border-transparent"
													}`}
													style={{ backgroundColor: option.value }}
												/>
											))}
										</div>
									</div>
									<Button type="submit" disabled={addingFolder || !newFolderName.trim()}>
										{addingFolder ? "Creating..." : "Create folder"}
									</Button>
								</form>
							</DialogContent>
						</Dialog>
					)}
				</NavSectionHeader>
			)}
			{!minimal && foldersSectionOpen && folders.length === 0 && (
				<div className="mx-6 rounded-lg border border-dashed border-neutral-200 px-3 py-3 text-xs text-neutral-400">
					No folders yet
				</div>
			)}
			{(minimal || foldersSectionOpen) && (
				<ReorderableList
					storageKey="kite:nav:layout:folders"
					enabled={!minimal}
					lists={[
						{
							id: "folders",
							visibleIds: (ordered) => {
								if (!foldersOverflow || foldersOpen) return ordered;
								const first = ordered.slice(0, MAX_VISIBLE_FOLDERS);
								const active = ordered.slice(MAX_VISIBLE_FOLDERS).find((id) => isActiveHref(`/folders/${id}`));
								return active ? [...first, active] : first;
							},
							items: folders.map((folder) => ({
								id: folder.id,
								node: (
									<NavItem
										wrap
										link={{
											href: `/folders/${folder.id}`,
											label: folder.name,
											icon: Folder,
											preloadMessages: true,
											iconColor: folder.color,
											count: counts.customFolders[folder.id]?.unread,
											onMessageDrop: (messageIds: string[]) => void moveMessagesToCustomFolder(messageIds, folder.id),
										}}
									/>
								),
							})),
						},
					]}
				/>
			)}
			{foldersSectionOpen && foldersOverflow && <NavToggle expanded={foldersOpen} onClick={toggleFolders} />}
		</SidebarScaffold>
	);
}

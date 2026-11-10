"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import toast from "react-hot-toast";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
	ChevronRight,
	FolderPlus,
	FolderSymlink,
	MoreVertical,
	Pencil,
	Unlink,
	Upload,
	UploadCloud,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/page";
import { LIST_HEAD_CLASS } from "@/components/ui/page-utils";
import { Skeleton } from "@/components/ui/skeleton";
import { mobileScrollClearsFloatingActionClass } from "@/components/page-header-utils";
import type { DriveMountDto, DriveMountItemDto } from "@/lib/drive/types";
import { refreshDrive } from "./drive-api";
import { DriveMountDialogs, type MountDialog } from "./drive-mount-dialogs";
import { DriveMountRow, MOUNT_GRID, type MountRowAction } from "./drive-mount-row";
import {
	deleteMountItem,
	mountFileUrl,
	mountHref,
	refreshMounts,
	unlinkMount,
	uploadMountFile,
} from "./drive-mounts-api";
import { useFileDropZone } from "./use-drive-browser";
import { useDriveMounts } from "./use-drive-mounts";
import { useMountListing } from "./use-mount-listing";

const segmentsOf = (path: string) => path.split("/").filter(Boolean);
const pathOf = (segments: string[]) => `/${segments.join("/")}`;

function Breadcrumbs({ mountId, label, path }: { mountId: string; label: string; path: string }) {
	const segments = segmentsOf(path);
	if (!segments.length)
		return (
			<h1 className="flex min-w-0 items-center gap-2 truncate px-1 text-base font-medium text-neutral-900">
				<FolderSymlink size={16} className="shrink-0 text-neutral-500" aria-hidden="true" />
				{label}
			</h1>
		);
	return (
		<nav aria-label="Folder path" className="flex min-w-0 flex-wrap items-center gap-0.5 text-base text-neutral-500">
			<Link href={mountHref(mountId)} className="rounded-md px-1.5 py-0.5 hover:bg-neutral-100 hover:text-neutral-900">
				{label}
			</Link>
			{segments.map((segment, index) => (
				<span key={pathOf(segments.slice(0, index + 1))} className="flex min-w-0 items-center gap-1">
					<ChevronRight size={16} className="shrink-0 text-neutral-400 rtl:-scale-x-100" aria-hidden="true" />
					{index === segments.length - 1 ? (
						<h1 className="truncate px-1.5 py-0.5 font-medium text-neutral-900">{segment}</h1>
					) : (
						<Link
							href={mountHref(mountId, pathOf(segments.slice(0, index + 1)))}
							className="truncate rounded-md px-1.5 py-0.5 hover:bg-neutral-100 hover:text-neutral-900"
						>
							{segment}
						</Link>
					)}
				</span>
			))}
		</nav>
	);
}

const menuItemClass =
	"flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm text-neutral-700 outline-none data-[highlighted]:bg-neutral-100";

function FolderMenu({ onEdit, onUnlink }: { onEdit: () => void; onUnlink: () => void }) {
	return (
		<DropdownMenu.Root>
			<DropdownMenu.Trigger asChild>
				<Button type="button" size="sm" variant="outline" aria-label="Linked folder settings">
					<MoreVertical size={16} />
				</Button>
			</DropdownMenu.Trigger>
			<DropdownMenu.Portal>
				<DropdownMenu.Content
					align="end"
					sideOffset={4}
					className="z-[200] min-w-52 rounded-xl border border-neutral-200 bg-white p-1 shadow-lg"
				>
					<DropdownMenu.Item className={menuItemClass} onSelect={onEdit}>
						<Pencil size={16} />
						Edit link
					</DropdownMenu.Item>
					<DropdownMenu.Item className={`${menuItemClass} text-red-600`} onSelect={onUnlink}>
						<Unlink size={16} />
						Unlink folder
					</DropdownMenu.Item>
				</DropdownMenu.Content>
			</DropdownMenu.Portal>
		</DropdownMenu.Root>
	);
}

function AuthBanner({ message, onFix }: { message: string; onFix: () => void }) {
	return (
		<div
			role="alert"
			className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-red-200 bg-red-50 px-5 py-2 text-sm text-red-800"
		>
			<span>{message}</span>
			<Button type="button" size="sm" variant="outline" onClick={onFix}>
				Update app password
			</Button>
		</div>
	);
}

function ListBody({
	state,
	items,
	onAction,
}: {
	state: ReturnType<typeof useMountListing>;
	items: DriveMountItemDto[];
	onAction: (item: DriveMountItemDto, action: MountRowAction) => void;
}) {
	if (state.loading && !state.listing)
		return (
			<div aria-hidden="true" className="space-y-1 p-3">
				{Array.from({ length: 6 }, (_, index) => (
					<Skeleton key={index} className="h-10 w-full" />
				))}
			</div>
		);
	if (state.listing?.migrationPending)
		return (
			<p className="p-12 text-center text-sm text-neutral-500">
				Drive needs a database update. An admin can apply it from the admin overview.
			</p>
		);
	if (state.error) return <p className="p-12 text-center text-sm text-neutral-500">{state.error.message}</p>;
	if (!items.length)
		return (
			<div className="p-4">
				<EmptyState icon={FolderSymlink} title="This folder is empty" description="Upload files or create a folder." />
			</div>
		);
	return (
		<>
			{items.map((item) => (
				<DriveMountRow key={item.path} item={item} onAction={(action) => onAction(item, action)} />
			))}
		</>
	);
}

function useMountActions(mount: DriveMountDto | null, setDialog: (dialog: MountDialog) => void) {
	const router = useRouter();
	const confirm = useConfirm();
	return useCallback(
		async (item: DriveMountItemDto, action: MountRowAction) => {
			if (!mount) return;
			if (action === "open" && item.kind === "folder") return router.push(mountHref(mount.id, item.path));
			if (action === "open") return setDialog({ kind: "preview", item });
			if (action === "download") return void window.open(mountFileUrl(mount.id, item.path, true), "_self");
			if (action === "rename" || action === "move") return setDialog({ kind: action, item });
			const confirmed = await confirm({
				title: `Delete “${item.name}”?`,
				description: `It is deleted on ${mount.label} at once${item.kind === "folder" ? ", with everything inside it" : ""}. Linked folders have no trash in Kite.`,
				confirmLabel: "Delete",
			});
			if (!confirmed) return;
			try {
				await deleteMountItem(mount.id, item.path);
				toast.success(`Deleted ${item.name}`);
				refreshDrive();
			} catch (failure) {
				toast.error(failure instanceof Error ? failure.message : "Could not delete");
			}
		},
		[confirm, mount, router, setDialog],
	);
}

async function uploadAll(mountId: string, path: string, files: File[]) {
	for (const file of files) {
		const id = toast.loading(`Uploading ${file.name}…`);
		try {
			await uploadMountFile(mountId, path, file);
			toast.success(`Uploaded ${file.name}`, { id });
		} catch (failure) {
			toast.error(failure instanceof Error ? failure.message : `Could not upload ${file.name}`, { id });
		}
	}
	refreshDrive();
}

/** A linked WebDAV folder in Drive: browse, preview, download, upload, new folder, rename, move and delete. */
export function DriveMountBrowser({ mountId }: { mountId: string }) {
	const params = useSearchParams();
	const router = useRouter();
	const confirm = useConfirm();
	const path = pathOf(segmentsOf(params.get("path") ?? "/"));
	const state = useMountListing(mountId, path);
	// The list in the Drive menu knows the folder even when the server refuses the listing (a wrong password).
	const { mounts } = useDriveMounts();
	const mount = state.listing?.mount ?? mounts.find((entry) => entry.id === mountId) ?? null;
	const [dialog, setDialog] = useState<MountDialog | null>(null);
	const fileInput = useRef<HTMLInputElement>(null);
	const onAction = useMountActions(mount, setDialog);
	const canWrite = !!mount && !state.error;
	const drop = useFileDropZone(canWrite, (files) => void uploadAll(mountId, path, files));
	const authFailed = state.error?.code === "WEBDAV_AUTH";
	// The server marked the folder when it refused the password; the Drive menu shows that mark too.
	useEffect(() => {
		if (authFailed) refreshMounts();
	}, [authFailed]);

	async function unlink() {
		if (!mount) return;
		const confirmed = await confirm({
			title: `Unlink “${mount.label}”?`,
			description: "It disappears from Drive. Nothing on the server is deleted, and you can link it again.",
			confirmLabel: "Unlink",
		});
		if (!confirmed) return;
		await unlinkMount(mount.id);
		refreshMounts();
		router.push("/drive");
	}

	return (
		<div className="relative flex h-full min-h-0 flex-col" {...drop.handlers} data-drive-view="mount">
			<input
				ref={fileInput}
				type="file"
				multiple
				hidden
				data-drive-file-input
				onChange={(event) => {
					void uploadAll(mountId, path, [...(event.target.files ?? [])]);
					event.target.value = "";
				}}
			/>
			<div className="@container flex min-h-0 flex-1 flex-col bg-white">
				<div
					data-panel-header
					className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-neutral-200 px-4 py-2"
				>
					<Breadcrumbs mountId={mountId} label={mount?.label ?? "Linked folder"} path={path} />
					{mount && (
						<div className="flex flex-wrap items-center gap-2">
							{canWrite && (
								<>
									<Button type="button" size="sm" variant="outline" onClick={() => setDialog({ kind: "new-folder" })}>
										<FolderPlus size={16} />
										New folder
									</Button>
									<Button type="button" size="sm" variant="outline" onClick={() => fileInput.current?.click()}>
										<Upload size={16} />
										Upload files
									</Button>
								</>
							)}
							<FolderMenu onEdit={() => setDialog({ kind: "edit" })} onUnlink={() => void unlink()} />
						</div>
					)}
				</div>
				{authFailed && mount && <AuthBanner message={state.error!.message} onFix={() => setDialog({ kind: "edit" })} />}
				<div className={`${MOUNT_GRID} ${LIST_HEAD_CLASS} shrink-0 px-5 py-2`}>
					<span className="font-medium">Name</span>
					<span className="hidden font-medium @2xl:block">Modified</span>
					<span className="hidden font-medium @2xl:block">Size</span>
					<span />
				</div>
				<div
					role="table"
					aria-label={mount?.label ?? "Linked folder"}
					className={`min-h-0 flex-1 space-y-px overflow-y-auto overscroll-contain px-2 pt-px ${mobileScrollClearsFloatingActionClass}`}
				>
					<ListBody
						state={state}
						items={state.listing?.items ?? []}
						onAction={(item, action) => void onAction(item, action)}
					/>
				</div>
			</div>
			{drop.over && (
				<div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-blue-500 bg-blue-50/80 text-neutral-900">
					<UploadCloud size={28} />
					<span className="ms-3 text-base font-medium">Drop to upload</span>
				</div>
			)}
			<DriveMountDialogs
				dialog={dialog}
				mount={mount}
				path={path}
				onClose={() => setDialog(null)}
				onChanged={() => {
					refreshDrive();
					refreshMounts();
				}}
			/>
		</div>
	);
}

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import toast from "react-hot-toast";
import { UploadCloud } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { parseDriveCategories, type DriveCategory } from "@/lib/drive/category-names-utils";
import type { DriveItemDto } from "@/lib/drive/types";
import { refreshDrive } from "./drive-api";
import { DriveDialogs } from "./drive-dialogs";
import { DRIVE_GRID, DriveItemRow } from "./drive-item-row";
import { DriveBreadcrumbs, DriveBulkBar, DriveCreateButtons, DriveTypeChips } from "./drive-toolbar";
import type { DriveDialog, DriveListing, DriveListingView } from "./drive-types";
import { DriveUploadPanel } from "./drive-upload-panel";
import {
	DRIVE_COMMAND_EVENT,
	DRIVE_VIEW_TITLES,
	driveFileUrl,
	isSelectable,
	sortDriveItems,
	viewHref,
	type DriveCommand,
} from "./drive-utils";
import { useDriveActions } from "./use-drive-actions";
import { useDriveSelection, useFileDropZone, useFileParam, useRowDrag, type DriveSelection } from "./use-drive-browser";
import { useDriveListing } from "./use-drive-listing";
import { useDriveUploads } from "./use-drive-uploads";

const EMPTY_TEXT: Record<DriveListingView, string> = {
	my: "Nothing here yet. Upload files or create a folder.",
	recent: "Files you add appear here.",
	shared: "Nothing has been shared with you yet.",
	attachments: "No attachments in your mailboxes.",
	trash: "The trash is empty.",
};

/** Whether new files and folders can go where the listing is: My Drive, or a folder you can edit. */
function takesUploads(view: DriveListingView, folderId: string | null, listing: DriveListing | null, query: string) {
	if (!listing || listing.migrationPending) return false;
	if (folderId) return listing.role === "owner" || listing.role === "edit";
	return view === "my" && !query;
}

function ListState({
	loading,
	error,
	notFound,
	pending,
	empty,
	emptyText,
}: {
	loading: boolean;
	error: string | null;
	notFound: boolean;
	pending: boolean;
	empty: boolean;
	emptyText: string;
}) {
	if (loading)
		return (
			<div aria-hidden="true" className="space-y-1 p-3">
				{Array.from({ length: 6 }, (_, index) => (
					<Skeleton key={index} className="h-10 w-full" />
				))}
			</div>
		);
	const message = pending
		? "Drive needs a database update. An admin can apply it from the admin overview."
		: notFound
			? "This folder does not exist or is not shared with you."
			: error
				? error
				: empty
					? emptyText
					: null;
	return message ? <p className="p-12 text-center text-sm text-neutral-500">{message}</p> : null;
}

function useListingQuery(view: DriveListingView, folderId: string | null) {
	const params = useSearchParams();
	const query = (params.get("q") ?? "").trim();
	const typesParam = params.get("types");
	const types = useMemo(() => parseDriveCategories(typesParam), [typesParam]);
	return useMemo(() => ({ view, folderId, query, types }), [view, folderId, query, types]);
}

function useSetParam() {
	const router = useRouter();
	const pathname = usePathname();
	const params = useSearchParams();
	return useCallback(
		(name: string, value: string) => {
			const next = new URLSearchParams(params.toString());
			if (value) next.set(name, value);
			else next.delete(name);
			router.replace(next.size ? `${pathname}?${next}` : pathname);
		},
		[params, pathname, router],
	);
}

function SearchBox({ initial, onSearch }: { initial: string; onSearch: (query: string) => void }) {
	const [value, setValue] = useState(initial);
	return (
		<form
			role="search"
			onSubmit={(event) => {
				event.preventDefault();
				onSearch(value.trim());
			}}
		>
			<Input
				type="search"
				aria-label="Search My Drive"
				placeholder="Search My Drive"
				value={value}
				onChange={(event) => setValue(event.target.value)}
				className="h-9 w-56 max-md:w-full"
			/>
		</form>
	);
}

function HiddenInputs({
	fileInput,
	folderInput,
	onFiles,
	onFolder,
}: {
	fileInput: React.RefObject<HTMLInputElement | null>;
	folderInput: React.RefObject<HTMLInputElement | null>;
	onFiles: (files: File[]) => void;
	onFolder: (files: File[]) => void;
}) {
	return (
		<>
			<input
				ref={fileInput}
				type="file"
				multiple
				hidden
				data-drive-file-input
				onChange={(event) => {
					onFiles([...(event.target.files ?? [])]);
					event.target.value = "";
				}}
			/>
			<input
				ref={folderInput}
				type="file"
				multiple
				hidden
				data-drive-folder-input
				{...{ webkitdirectory: "" }}
				onChange={(event) => {
					onFolder([...(event.target.files ?? [])]);
					event.target.value = "";
				}}
			/>
		</>
	);
}

function ColumnHeader({ view, selection }: { view: DriveListingView; selection: DriveSelection }) {
	return (
		<div className={`${DRIVE_GRID} shrink-0 border-b border-neutral-200 px-5 py-2 text-sm text-neutral-600`}>
			<Checkbox
				checked={selection.allSelected}
				onChange={selection.toggleAll}
				disabled={selection.selectable.length === 0}
				aria-label="Select all"
				className="ml-1"
			/>
			<span className="pl-7 font-medium">Name</span>
			<span className="hidden font-medium md:block">{view === "attachments" ? "From" : "Owner"}</span>
			<span className="hidden font-medium md:block">{view === "trash" ? "Trashed" : "Modified"}</span>
			<span className="hidden font-medium md:block">Size</span>
			<span />
		</div>
	);
}

function LoadMore({ onLoad, loading }: { onLoad: () => void; loading: boolean }) {
	return (
		<div className="flex justify-center py-4">
			<button
				type="button"
				onClick={onLoad}
				disabled={loading}
				className="rounded-full px-4 py-2 text-sm font-medium text-blue-700 hover:bg-blue-50"
			>
				{loading ? "Loading…" : "Load more"}
			</button>
		</div>
	);
}

function DropOverlay() {
	return (
		<div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-blue-500 bg-blue-50/80 text-blue-700">
			<UploadCloud size={28} />
			<span className="ml-3 text-base font-medium">Drop to upload</span>
		</div>
	);
}

function useDriveCommands(canWrite: boolean, openDialog: (dialog: DriveDialog) => void) {
	const fileInput = useRef<HTMLInputElement>(null);
	const folderInput = useRef<HTMLInputElement>(null);
	const onCommand = useCallback(
		(command: DriveCommand) => {
			if (!canWrite) return void toast.error("Open My Drive or a folder you can edit to add files.");
			if (command === "new-folder") openDialog({ kind: "new-folder" });
			else (command === "upload-files" ? fileInput : folderInput).current?.click();
		},
		[canWrite, openDialog],
	);
	useEffect(() => {
		const listener = (event: Event) => onCommand((event as CustomEvent<DriveCommand>).detail);
		window.addEventListener(DRIVE_COMMAND_EVENT, listener);
		return () => window.removeEventListener(DRIVE_COMMAND_EVENT, listener);
	}, [onCommand]);
	return { fileInput, folderInput, onCommand };
}

function listingTitles(view: DriveListingView, folderId: string | null, listing: DriveListing | null, query: string) {
	const shared = !!folderId && listing?.role !== "owner";
	const rootTitle = shared ? DRIVE_VIEW_TITLES.shared : DRIVE_VIEW_TITLES[view];
	return {
		rootHref: shared ? viewHref("shared") : viewHref(view),
		title: query ? `Search results for “${query}”` : rootTitle,
	};
}

function TrashNote() {
	return (
		<p className="shrink-0 border-b border-neutral-200 bg-neutral-50 px-5 py-2 text-xs text-neutral-600">
			Items in the trash are deleted forever after the retention period an admin sets.
		</p>
	);
}

type DriveHeaderProps = {
	view: DriveListingView;
	folderId: string | null;
	title: string;
	rootHref: string;
	listing: DriveListing | null;
	query: ReturnType<typeof useListingQuery>;
	canWrite: boolean;
	selection: DriveSelection;
	onCommand: (command: DriveCommand) => void;
	setParam: (name: string, value: string) => void;
	onMove: () => void;
	runBulk: ReturnType<typeof useDriveActions>["runBulk"];
};

function DriveHeader(props: DriveHeaderProps) {
	const { view, folderId, query, selection, runBulk } = props;
	return (
		<div className="flex shrink-0 flex-col gap-3 border-b border-neutral-200 px-5 py-3">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<DriveBreadcrumbs title={props.title} rootHref={props.rootHref} path={props.listing?.path ?? []} />
				<div className="flex flex-wrap items-center gap-2">
					{view === "my" && !folderId && (
						<SearchBox key={query.query} initial={query.query} onSearch={(value) => props.setParam("q", value)} />
					)}
					{props.canWrite && <DriveCreateButtons onCommand={props.onCommand} />}
				</div>
			</div>
			<div className="flex flex-wrap items-center justify-between gap-3">
				<DriveTypeChips
					value={query.types}
					onChange={(next: DriveCategory[]) => props.setParam("types", next.join(","))}
				/>
				{selection.selected.length > 0 && (
					<DriveBulkBar
						selected={selection.selected}
						inTrash={view === "trash"}
						handlers={{
							onClear: selection.clear,
							onMove: props.onMove,
							onTrash: () => void runBulk(selection.selected, "trash"),
							onRestore: () => void runBulk(selection.selected, "restore"),
							onDelete: () => void runBulk(selection.selected, "delete"),
							onDownload: () => downloadAll(selection.selected),
						}}
					/>
				)}
			</div>
		</div>
	);
}

/** The Drive listing pages: My Drive and its folders, Recent, Shared with me, All attachments and Trash. */
export function DriveBrowser({ view, folderId = null }: { view: DriveListingView; folderId?: string | null }) {
	const query = useListingQuery(view, folderId);
	const setParam = useSetParam();
	const { listing, loading, error, notFound, loadMore, loadingMore } = useDriveListing(query);
	const [dialog, setDialog] = useState<DriveDialog | null>(null);
	const openDialog = useCallback((next: DriveDialog) => setDialog(next), []);
	const items = useMemo(() => sortDriveItems(listing?.items ?? [], "name", true), [listing]);
	const selection = useDriveSelection(items, `${view}|${folderId ?? ""}`);
	const { onRowAction, runBulk } = useDriveActions(openDialog, refreshDrive);
	const uploads = useDriveUploads(refreshDrive);
	const rowDrag = useRowDrag(selection.selected, refreshDrive);
	const canWrite = takesUploads(view, folderId, listing, query.query);
	const parentId = listing?.folder?.id ?? folderId;
	const drop = useFileDropZone(canWrite, (files) => uploads.uploadFiles(files, parentId));
	const { fileInput, folderInput, onCommand } = useDriveCommands(canWrite, openDialog);
	useFileParam(openDialog);
	const { title, rootHref } = listingTitles(view, folderId, listing, query.query);

	return (
		<div className="relative flex h-full min-h-0 flex-col" {...drop.handlers} data-drive-view={view}>
			<HiddenInputs
				fileInput={fileInput}
				folderInput={folderInput}
				onFiles={(files) => uploads.uploadFiles(files, parentId)}
				onFolder={(files) => void uploads.uploadFolder(files, parentId)}
			/>
			<div className="flex min-h-0 flex-1 flex-col rounded-t-3xl bg-white">
				<DriveHeader
					{...{ view, folderId, title, rootHref, listing, query, canWrite, selection, onCommand, setParam, runBulk }}
					onMove={() => setDialog({ kind: "move", items: selection.selected })}
				/>
				{view === "trash" && <TrashNote />}
				<ColumnHeader view={view} selection={selection} />
				<div
					role="table"
					aria-label={title}
					className="min-h-0 flex-1 space-y-px overflow-y-auto overscroll-contain px-2 pt-px"
				>
					<ListState
						loading={loading}
						error={error}
						notFound={notFound}
						pending={!!listing?.migrationPending}
						empty={items.length === 0}
						emptyText={query.query ? "No files match your search." : EMPTY_TEXT[view]}
					/>
					{items.map((item) => (
						<DriveItemRow
							key={item.id}
							item={item}
							selected={selection.ids.has(item.id)}
							selectable={isSelectable(item)}
							onToggle={() => selection.toggle(item.id)}
							onAction={(action) => onRowAction(item, action)}
							drag={rowDrag(item)}
						/>
					))}
					{listing?.nextCursor && <LoadMore onLoad={() => void loadMore()} loading={loadingMore} />}
				</div>
			</div>
			{drop.over && <DropOverlay />}
			<DriveDialogs dialog={dialog} folderId={parentId} onClose={() => setDialog(null)} onChanged={refreshDrive} />
			<DriveUploadPanel uploads={uploads.uploads} onCancel={uploads.cancel} onClose={uploads.clearFinished} />
		</div>
	);
}

/** Downloads each selected file in turn; folders are skipped. */
function downloadAll(items: DriveItemDto[]) {
	const files = items.filter((item) => item.kind === "file");
	files.forEach((item, index) => {
		window.setTimeout(() => {
			const anchor = document.createElement("a");
			anchor.href = driveFileUrl(item, true);
			anchor.rel = "noopener";
			document.body.appendChild(anchor);
			anchor.click();
			anchor.remove();
		}, index * 300);
	});
}

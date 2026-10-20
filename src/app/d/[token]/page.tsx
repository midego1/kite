"use client";

import { use, useCallback, useEffect, useState } from "react";
import { ChevronRight, Download } from "lucide-react";
import { DrivePreviewBody } from "@/components/drive/drive-preview";
import { driveIconFor } from "@/components/drive/drive-icons";
import { publicContentUrl } from "@/components/drive/drive-utils";
import { formatDriveSize } from "@/lib/drive/name-utils";
import { PublicDriveError, PublicDriveFrame, PublicDriveMissing, PublicDrivePassword } from "./public-drive-states";
import type { PublicDriveItem, PublicDriveListing, PublicDriveState } from "./public-drive-types";

async function loadListing(token: string, itemId: string | null): Promise<PublicDriveState> {
	const search = itemId ? `?item=${encodeURIComponent(itemId)}` : "";
	try {
		const response = await fetch(`/api/public/drive/${encodeURIComponent(token)}${search}`, { cache: "no-store" });
		if (response.ok) return { kind: "ready", data: (await response.json()) as PublicDriveListing };
		if (response.status === 401) return { kind: "password" };
		if (response.status === 429) return { kind: "error", message: "Too many requests. Try again in a minute." };
		return { kind: "missing" };
	} catch {
		return { kind: "error", message: "Could not reach the server." };
	}
}

/** Folders first, then by name; the server orders by kind alphabetically, which puts files first. */
function sortPublicItems(items: readonly PublicDriveItem[]): PublicDriveItem[] {
	return [...items].sort((a, b) =>
		a.kind !== b.kind ? (a.kind === "folder" ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true }),
	);
}

export default function PublicDrivePage({ params }: { params: Promise<{ token: string }> }) {
	const { token } = use(params);
	const [itemId, setItemId] = useState<string | null>(null);
	const [state, setState] = useState<PublicDriveState>({ kind: "loading" });
	const [attempt, setAttempt] = useState(0);
	const reload = useCallback(() => setAttempt((value) => value + 1), []);

	useEffect(() => {
		let active = true;
		void loadListing(token, itemId).then((next) => {
			if (active) setState(next);
		});
		return () => {
			active = false;
		};
	}, [token, itemId, attempt]);

	if (state.kind === "missing") return <PublicDriveMissing />;
	if (state.kind === "error") return <PublicDriveError message={state.message} />;
	if (state.kind === "password") return <PublicDrivePassword token={token} onUnlocked={reload} />;
	if (state.kind === "loading")
		return <PublicDriveFrame wide>{<div aria-busy="true" className="h-64" />}</PublicDriveFrame>;
	return <PublicDriveView token={token} data={state.data} onOpen={setItemId} />;
}

function PublicDriveView({
	token,
	data,
	onOpen,
}: {
	token: string;
	data: PublicDriveListing;
	onOpen: (id: string) => void;
}) {
	const { item, items, path } = data;
	const isFile = item.kind === "file";
	return (
		<PublicDriveFrame wide>
			<nav
				aria-label="Folder path"
				className="mb-4 flex flex-wrap items-center gap-1 text-lg text-neutral-800 dark:text-neutral-200"
			>
				{path.map((crumb, index) => (
					<span key={crumb.id} className="flex items-center gap-1">
						{index > 0 && <ChevronRight size={18} className="text-neutral-500" />}
						{index === path.length - 1 ? (
							<h1 className="px-2 py-1 font-medium">{crumb.name}</h1>
						) : (
							<button
								type="button"
								onClick={() => onOpen(crumb.id)}
								className="rounded-full px-2 py-1 hover:bg-neutral-200/60 dark:hover:bg-neutral-800"
							>
								{crumb.name}
							</button>
						)}
					</span>
				))}
				{isFile && (
					<a
						href={publicContentUrl(token, item.id, true)}
						className="ml-auto inline-flex items-center gap-2 rounded-full bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
					>
						<Download size={16} />
						Download
					</a>
				)}
			</nav>
			{isFile ? (
				<div className="min-h-[70vh] flex-1 rounded-2xl bg-neutral-900 p-3">
					<DrivePreviewBody
						src={publicContentUrl(token, item.id)}
						downloadHref={publicContentUrl(token, item.id, true)}
						contentType={item.contentType}
						name={item.name}
					/>
				</div>
			) : (
				<div role="list" aria-label={item.name} className="rounded-2xl bg-white p-2 shadow-sm dark:bg-neutral-900">
					{items.length === 0 ? (
						<p className="p-10 text-center text-sm text-neutral-500">This folder is empty.</p>
					) : (
						sortPublicItems(items).map((entry) => (
							<PublicRow key={entry.id} entry={entry} token={token} onOpen={onOpen} />
						))
					)}
				</div>
			)}
		</PublicDriveFrame>
	);
}

function PublicRow({ entry, token, onOpen }: { entry: PublicDriveItem; token: string; onOpen: (id: string) => void }) {
	const { Icon, className } = driveIconFor(entry);
	return (
		<div
			role="listitem"
			className="flex items-center gap-4 rounded-lg px-3 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800"
		>
			<button
				type="button"
				onClick={() => onOpen(entry.id)}
				className="flex min-w-0 flex-1 items-center gap-4 py-3 text-left"
			>
				<Icon size={16} className={className} fill={entry.kind === "folder" ? "currentColor" : "none"} />
				<span className="truncate text-neutral-900 dark:text-neutral-100">{entry.name}</span>
			</button>
			{entry.kind === "file" && (
				<span className="hidden shrink-0 text-neutral-500 sm:block">{formatDriveSize(entry.size)}</span>
			)}
			{entry.kind === "file" && (
				<a
					href={publicContentUrl(token, entry.id, true)}
					aria-label={`Download ${entry.name}`}
					className="shrink-0 rounded-full p-2 text-neutral-600 hover:bg-neutral-200 dark:hover:bg-neutral-700"
				>
					<Download size={16} />
				</a>
			)}
		</div>
	);
}

"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { requestConfirmation } from "@/components/ui/confirm-dialog-utils";
import { SkeletonRows } from "@/components/ui/skeleton";
import { DataRoutes } from "./data-routes";
import { MigrationsCard } from "./migrations-card";
import { StepList, StoreDialog } from "./store-dialog";
import type { StorageOverview, StoreView, ValidationStep } from "./types";
import {
	CLASS_LABELS,
	STORAGE_QUERY_KEY,
	errorText,
	fetchStorageOverview,
	formatCheckedAt,
	isRunning,
	providerLabel,
	statusBadge,
	storageRequest,
} from "./utils";
import { Notice } from "@/components/ui/notice";
import { PageHeader } from "@/components/ui/page";

type DialogState = { store: StoreView | null; binding?: boolean } | null;

function StoreRow({
	store,
	onEdit,
	onChanged,
}: {
	store: StoreView;
	onEdit: (store: StoreView) => void;
	onChanged: () => void;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [steps, setSteps] = useState<ValidationStep[] | null>(null);
	const badge = statusBadge(store);
	const fromEnvironment = store.source === "environment";

	async function test() {
		setBusy(true);
		setError(null);
		try {
			const answer = await storageRequest<{ report: { steps: ValidationStep[] } }>(
				`/stores/${encodeURIComponent(store.id)}/test`,
				{ method: "POST" },
			);
			setSteps(answer.report.steps);
			onChanged();
		} catch (caught) {
			setError(errorText(caught, "Could not test the store"));
		} finally {
			setBusy(false);
		}
	}

	async function remove() {
		const confirmed = await requestConfirmation({
			title: `Delete ${store.name}?`,
			description: "Kite forgets this store and its saved keys. The bucket and its objects are not touched.",
			confirmLabel: "Delete store",
		});
		if (!confirmed) return;
		setBusy(true);
		setError(null);
		try {
			await storageRequest(`/stores/${encodeURIComponent(store.id)}`, { method: "DELETE" });
			onChanged();
		} catch (caught) {
			setError(errorText(caught, "Could not delete the store"));
		} finally {
			setBusy(false);
		}
	}

	return (
		<li data-store={store.id} className="space-y-2 py-3">
			<div className="flex flex-wrap items-center gap-3">
				<div className="min-w-48 flex-1">
					<p className="font-medium text-neutral-900">
						{store.name}
						<span className={`ml-2 rounded-md px-2 py-0.5 text-xs font-medium ${badge.className}`}>{badge.label}</span>
					</p>
					<p className="text-sm text-neutral-500">
						{providerLabel(store.provider)}, bucket {store.bucket}
						{store.usedBy.length ? `, used for ${store.usedBy.map((name) => CLASS_LABELS[name]).join(", ")}` : ""}
						{store.sameAsBinding ? ", direct uploads for the default store" : ""}
					</p>
					<p className="text-xs text-neutral-500">
						{fromEnvironment ? "From STORAGE_S3_* variables" : formatCheckedAt(store.lastCheckedAt)}
					</p>
					{(store.blocked ?? store.lastError) && (
						<p className="text-sm text-red-600">{store.blocked ?? store.lastError}</p>
					)}
				</div>
				<div className="flex gap-2">
					<Button size="sm" variant="outline" disabled={busy || !!store.blocked} onClick={() => void test()}>
						{busy ? "Testing…" : "Test"}
					</Button>
					{!fromEnvironment && (
						<>
							<Button size="sm" variant="outline" disabled={busy} onClick={() => onEdit(store)}>
								Edit
							</Button>
							<Button size="sm" variant="outline" disabled={busy} onClick={() => void remove()}>
								Delete
							</Button>
						</>
					)}
				</div>
			</div>
			{error && (
				<p role="alert" className="text-sm text-red-600">
					{error}
				</p>
			)}
			{steps && <StepList steps={steps} />}
		</li>
	);
}

function StoresCard({
	overview,
	onDialog,
	onChanged,
}: {
	overview: StorageOverview;
	onDialog: (state: DialogState) => void;
	onChanged: () => void;
}) {
	const { defaultStore } = overview;
	const canAdd = overview.encryptionReady;
	return (
		<section aria-labelledby="storage-stores" className="rounded-xl border border-neutral-200 bg-white p-5">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h2 id="storage-stores" className="text-lg font-semibold text-neutral-900">
						Stores
					</h2>
					<p className="mt-1 text-sm text-neutral-500">Buckets Kite can keep files in.</p>
				</div>
				<Button size="sm" disabled={!canAdd} onClick={() => onDialog({ store: null })}>
					<Plus aria-hidden className="h-4 w-4" />
					Add store
				</Button>
			</div>
			<ul className="mt-2 divide-y divide-neutral-200">
				<li data-store="default" className="flex flex-wrap items-center gap-3 py-3">
					<div className="min-w-48 flex-1">
						<p className="font-medium text-neutral-900">
							Default: {defaultStore.name}
							<span className="ml-2 rounded-md bg-green-600/10 px-2 py-0.5 text-xs font-medium text-green-800">
								Built in
							</span>
						</p>
						<p className="text-sm text-neutral-500">
							{defaultStore.kind === "r2"
								? defaultStore.directUploads
									? "The Worker's bucket binding. Browsers upload Drive files to it directly."
									: "The Worker's bucket binding. Drive uploads pass through Kite."
								: "Files in Kite's data directory. Drive uploads pass through Kite."}
						</p>
					</div>
					{defaultStore.kind === "r2" && !defaultStore.directUploads && (
						<Button
							size="sm"
							variant="outline"
							disabled={!canAdd}
							onClick={() => onDialog({ store: null, binding: true })}
						>
							Enable direct uploads
						</Button>
					)}
				</li>
				{overview.stores.map((store) => (
					<StoreRow key={store.id} store={store} onEdit={(entry) => onDialog({ store: entry })} onChanged={onChanged} />
				))}
			</ul>
		</section>
	);
}

export function StorageAdmin() {
	const queryClient = useQueryClient();
	const [dialog, setDialog] = useState<DialogState>(null);
	const overview = useQuery({
		queryKey: STORAGE_QUERY_KEY,
		queryFn: fetchStorageOverview,
		refetchInterval: (query) => (query.state.data?.migrations.some(isRunning) ? 3000 : false),
	});
	const refresh = () => void queryClient.invalidateQueries({ queryKey: STORAGE_QUERY_KEY });
	const data = overview.data;

	return (
		<div className="space-y-6">
			<PageHeader
				title="Storage"
				description="Keep mail, Drive files and backups in Cloudflare R2 or any S3-compatible bucket, and move them between stores without downtime."
			/>
			{overview.isError && <Notice tone="error">{errorText(overview.error, "Failed to load storage")}</Notice>}
			{overview.isLoading && <SkeletonRows count={4} />}
			{data?.migrationPending && (
				<Notice>
					Apply the pending database update to set up storage. Until then everything stays in the default store.
				</Notice>
			)}
			{data && !data.migrationPending && !data.encryptionReady && (
				<Notice>Set APP_ENCRYPTION_KEY to add stores. Store keys are only ever saved encrypted.</Notice>
			)}
			{data && !data.migrationPending && (
				<>
					<StoresCard overview={data} onDialog={setDialog} onChanged={refresh} />
					<DataRoutes overview={data} onChanged={refresh} />
					<MigrationsCard overview={data} onChanged={refresh} />
				</>
			)}
			{dialog && (
				<StoreDialog store={dialog.store} binding={dialog.binding} onClose={() => setDialog(null)} onSaved={refresh} />
			)}
		</div>
	);
}

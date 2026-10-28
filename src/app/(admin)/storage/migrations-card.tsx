"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { requestConfirmation } from "@/components/ui/confirm-dialog-utils";
import type { MigrationView, StorageOverview } from "./types";
import {
	CLASS_LABELS,
	awaitsFinish,
	errorText,
	isRunning,
	migrationLabel,
	migrationProgress,
	storageRequest,
	storeName,
} from "./utils";

function MigrationRow({
	overview,
	migration,
	onChanged,
}: {
	overview: StorageOverview;
	migration: MigrationView;
	onChanged: () => void;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const from = storeName(overview, migration.fromStoreId);
	const to = storeName(overview, migration.toStoreId);
	const label = CLASS_LABELS[migration.objectClass];

	async function act(action: "cancel" | "finish" | "retry" | "purge-source", confirm?: string) {
		setBusy(true);
		setError(null);
		try {
			await storageRequest(`/migrations/${encodeURIComponent(migration.id)}`, {
				method: "POST",
				json: { action, confirm },
			});
			onChanged();
		} catch (caught) {
			setError(errorText(caught, "Could not update the migration"));
		} finally {
			setBusy(false);
		}
	}

	async function purge() {
		const confirmed = await requestConfirmation({
			title: `Delete ${label.toLowerCase()} from ${from}?`,
			description: `Each object is deleted from ${from} only after Kite has confirmed its copy on ${to}. Kite stops reading from ${from} first. This cannot be undone.`,
			confirmLabel: "Delete old copies",
			typedConfirmation: from,
		});
		if (confirmed) await act("purge-source", from);
	}

	const finishable = awaitsFinish(overview, migration);
	return (
		<li data-migration={migration.id} data-status={migration.status} className="space-y-2 py-3">
			<div className="flex flex-wrap items-baseline justify-between gap-2">
				<p className="font-medium text-neutral-900">
					{label}: {from} to {to}
				</p>
				<p role="status" className="text-sm text-neutral-600">
					{migrationLabel(migration)}
				</p>
			</div>
			<p className="text-sm text-neutral-500">{migrationProgress(migration)}</p>
			{migration.lastError && <p className="text-sm text-red-600">{migration.lastError}</p>}
			{error && (
				<p role="alert" className="text-sm text-red-600">
					{error}
				</p>
			)}
			<div className="flex flex-wrap gap-2">
				{isRunning(migration) && migration.phase !== "purge" && (
					<Button size="sm" variant="outline" disabled={busy} onClick={() => void act("cancel")}>
						Cancel
					</Button>
				)}
				{migration.status === "failed" && (
					<Button size="sm" variant="outline" disabled={busy} onClick={() => void act("retry")}>
						Retry
					</Button>
				)}
				{finishable && (
					<>
						<Button size="sm" variant="outline" disabled={busy} onClick={() => void act("finish")}>
							Finish and keep old copies
						</Button>
						<Button size="sm" variant="destructive" disabled={busy} onClick={() => void purge()}>
							Delete from {from}
						</Button>
					</>
				)}
			</div>
			{finishable && (
				<p className="text-xs text-neutral-500">
					Until you choose, Kite keeps reading from both stores. It finishes by itself after seven days and keeps the
					old copies.
				</p>
			)}
		</li>
	);
}

export function MigrationsCard({ overview, onChanged }: { overview: StorageOverview; onChanged: () => void }) {
	if (!overview.migrations.length) return null;
	return (
		<section aria-labelledby="storage-migrations" className="rounded-xl border border-neutral-200 bg-white p-5">
			<h2 id="storage-migrations" className="text-lg font-semibold text-neutral-900">
				Migrations
			</h2>
			<ul className="mt-2 divide-y divide-neutral-200">
				{overview.migrations.map((migration) => (
					<MigrationRow key={migration.id} overview={overview} migration={migration} onChanged={onChanged} />
				))}
			</ul>
		</section>
	);
}

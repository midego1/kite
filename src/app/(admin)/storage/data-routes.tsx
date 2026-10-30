"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";
import type { RoutableClass } from "@/lib/storage/types";
import { StepList } from "./step-list";
import type { ListStep, RouteView, StorageOverview } from "./types";
import {
	CLASS_CONTENTS,
	CLASS_LABELS,
	StorageRequestError,
	errorText,
	formatUsage,
	isRunning,
	routableStores,
	storageRequest,
	storeName,
} from "./utils";

type Pending = { route: RouteView; storeId: string };

function SwitchDialog({
	overview,
	pending,
	onClose,
	onSwitched,
}: {
	overview: StorageOverview;
	pending: Pending;
	onClose: () => void;
	onSwitched: () => void;
}) {
	const { route, storeId } = pending;
	const label = CLASS_LABELS[route.objectClass];
	const leftovers = storeId === route.storeId;
	const [migrate, setMigrate] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [steps, setSteps] = useState<ListStep[] | null>(null);
	const from = storeName(overview, leftovers ? (route.previousStoreId ?? route.storeId) : route.storeId);
	const to = storeName(overview, storeId);

	async function submit() {
		setBusy(true);
		setError(null);
		try {
			await storageRequest(`/routes/${route.objectClass}`, {
				method: "PUT",
				json: { storeId, migrate: leftovers || migrate },
			});
			onSwitched();
			onClose();
		} catch (caught) {
			const details = caught instanceof StorageRequestError ? caught.details : {};
			setSteps(details.report?.steps ?? details.steps ?? null);
			setError(errorText(caught, "Could not switch the store"));
		} finally {
			setBusy(false);
		}
	}

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-h-[calc(100vh-4rem)] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>{leftovers ? `Copy the rest of ${label} to ${to}?` : `Store ${label} in ${to}?`}</DialogTitle>
					<DialogDescription>
						{leftovers
							? `Copies what is still on ${from} to ${to}. Kite keeps reading from both until you finish.`
							: `New ${label.toLowerCase()} goes to ${to} within 30 seconds. Existing objects stay readable from ${from}.`}
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-4 text-sm text-neutral-700">
					{!leftovers && (
						<label className="flex items-start gap-2">
							<Checkbox checked={migrate} onChange={(event) => setMigrate(event.target.checked)} className="mt-0.5" />
							<span>
								Copy existing {label.toLowerCase()} to {to}
								{route.objectClass === "backups" ? " (older backups stay readable either way)" : ""}
							</span>
						</label>
					)}
					<p>
						Copying reads every object from the old store and writes it to the new one. Providers may charge for the
						requests and for data leaving the old store. Nothing is deleted until you choose to.
					</p>
					<p>Preview deployments share this setting, because they use the same database.</p>
					{error && (
						<p role="alert" className="text-red-600">
							{error}
						</p>
					)}
					{steps && <StepList steps={steps} />}
				</div>
				<div className="mt-6 flex justify-end gap-2">
					<Button type="button" variant="outline" onClick={onClose}>
						Cancel
					</Button>
					<Button type="button" disabled={busy} onClick={() => void submit()}>
						{busy ? "Checking…" : leftovers ? "Copy" : "Switch"}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}

export function DataRoutes({ overview, onChanged }: { overview: StorageOverview; onChanged: () => void }) {
	const [choices, setChoices] = useState<Partial<Record<RoutableClass, string>>>({});
	const [pending, setPending] = useState<Pending | null>(null);
	const options = routableStores(overview);

	return (
		<section aria-labelledby="where-data-lives" className="rounded-xl border border-neutral-200 bg-white p-5">
			<h2 id="where-data-lives" className="text-lg font-semibold text-neutral-900">
				Where data lives
			</h2>
			<p className="mt-1 text-sm text-neutral-500">
				Each kind of data can live in its own store. Search indexes, settings and the database stay in Kite.
			</p>
			<div className="mt-4 divide-y divide-neutral-200">
				{overview.routes.map((route) => {
					const choice = choices[route.objectClass] ?? route.storeId;
					const running = overview.migrations.some(
						(migration) => migration.objectClass === route.objectClass && isRunning(migration),
					);
					const hasLeftovers = !!route.previousStoreId && route.previousStoreId !== route.storeId;
					const canCopyRest = choice === route.storeId && hasLeftovers;
					// Why Switch is unavailable, as a tooltip and for screen readers; null while it can be used.
					const switchHint = running
						? "Wait for the running copy to finish"
						: choice === route.storeId && !canCopyRest
							? "Pick another store to switch"
							: null;
					return (
						<div
							key={route.objectClass}
							data-class={route.objectClass}
							className="flex flex-wrap items-center gap-3 py-3"
						>
							<div className="min-w-48 flex-1">
								<p className="font-medium text-neutral-900">{CLASS_LABELS[route.objectClass]}</p>
								<p className="text-sm text-neutral-500">
									{CLASS_CONTENTS[route.objectClass]}:{" "}
									{formatUsage(overview.usage[route.objectClass], route.objectClass)}
								</p>
								{hasLeftovers && (
									<p className="text-sm text-neutral-500">
										Also reading from {storeName(overview, route.previousStoreId!)}
									</p>
								)}
							</div>
							<Select
								aria-label={`Store for ${CLASS_LABELS[route.objectClass]}`}
								value={choice}
								disabled={running}
								containerClassName="h-9"
								className="text-sm"
								onChange={(event) => setChoices((current) => ({ ...current, [route.objectClass]: event.target.value }))}
							>
								{options.map((option) => (
									<option key={option.id} value={option.id}>
										{option.name}
									</option>
								))}
							</Select>
							<Tooltip label={switchHint}>
								<Button
									type="button"
									size="sm"
									variant="outline"
									disabled={!!switchHint}
									aria-describedby={switchHint ? `switch-hint-${route.objectClass}` : undefined}
									onClick={() => setPending({ route, storeId: choice })}
								>
									{canCopyRest ? "Copy the rest" : "Switch"}
								</Button>
							</Tooltip>
							{switchHint && (
								<span id={`switch-hint-${route.objectClass}`} className="sr-only">
									{switchHint}
								</span>
							)}
						</div>
					);
				})}
			</div>
			{pending && (
				<SwitchDialog overview={overview} pending={pending} onClose={() => setPending(null)} onSwitched={onChanged} />
			)}
		</section>
	);
}

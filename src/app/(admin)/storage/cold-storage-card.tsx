"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import type { ColdJobView, ColdRuleView, StorageOverview } from "./types";
import {
	COLD_QUERY_KEY,
	coldJobLabel,
	coldJobSummary,
	coldRuleToBody,
	coldRuleToForm,
	isColdJobRunning,
	R2_IA_TARGET,
	type ColdRuleForm,
} from "./cold-storage-utils";
import { CLASS_CONTENTS, CLASS_LABELS, errorText, routableStores, storageRequest } from "./utils";
import type { RoutableClass } from "@/lib/storage/types";

type ColdData = { rules: ColdRuleView[]; jobs: ColdJobView[]; iaAvailable: boolean };

async function fetchCold(): Promise<ColdData> {
	return storageRequest<ColdData>("/cold");
}

function ColdRuleRow({
	overview,
	rule,
	job,
	iaAvailable,
	onChanged,
}: {
	overview: StorageOverview;
	rule: ColdRuleView;
	job: ColdJobView | undefined;
	iaAvailable: boolean;
	onChanged: () => void;
}) {
	// The row mounts only once `rule` has its real fetched value; a later refetch reflects this component's own
	// save, so there is nothing to resync.
	const [form, setForm] = useState<ColdRuleForm>(() => coldRuleToForm(rule));
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const stores = routableStores(overview).filter((store) => store.id !== overview.defaultStore.id);
	const update = (change: Partial<ColdRuleForm>) => setForm((current) => ({ ...current, ...change }));

	async function save() {
		const built = coldRuleToBody(form);
		if ("error" in built) return setError(built.error);
		setBusy(true);
		setError(null);
		try {
			await storageRequest(`/cold/${rule.objectClass}`, { method: "PUT", json: built.body });
			onChanged();
		} catch (caught) {
			setError(errorText(caught, "Could not save the rule"));
		} finally {
			setBusy(false);
		}
	}

	async function runNow() {
		setBusy(true);
		setError(null);
		try {
			await storageRequest(`/cold/${rule.objectClass}`, { method: "POST" });
			onChanged();
		} catch (caught) {
			setError(errorText(caught, "Could not start the sweep"));
		} finally {
			setBusy(false);
		}
	}

	const id = `cold-${rule.objectClass}`;
	return (
		<li data-cold-rule={rule.objectClass} className="space-y-3 py-4">
			<div className="flex flex-wrap items-baseline justify-between gap-2">
				<div>
					<p className="font-medium text-neutral-900">{CLASS_LABELS[rule.objectClass]}</p>
					<p className="text-sm text-neutral-500">{CLASS_CONTENTS[rule.objectClass]}</p>
				</div>
				<p role="status" className="text-sm text-neutral-600">
					{coldJobLabel(job)}
				</p>
			</div>
			<div className="flex flex-wrap items-end gap-3">
				<div className="space-y-1.5">
					<Label htmlFor={`${id}-days`}>Older than (days)</Label>
					<Input
						id={`${id}-days`}
						type="number"
						min={1}
						inputMode="numeric"
						value={form.afterDays}
						onChange={(event) => update({ afterDays: event.target.value })}
						disabled={busy}
						className="max-w-28"
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor={`${id}-size`}>Minimum size (MB)</Label>
					<Input
						id={`${id}-size`}
						inputMode="decimal"
						placeholder="None"
						value={form.minBytesMb}
						onChange={(event) => update({ minBytesMb: event.target.value })}
						disabled={busy || rule.objectClass === "mail"}
						className="max-w-28"
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor={`${id}-target`}>Move to</Label>
					<Select
						id={`${id}-target`}
						value={form.target}
						onChange={(event) => update({ target: event.target.value })}
						disabled={busy}
					>
						<option value={R2_IA_TARGET} disabled={!iaAvailable}>
							R2 Infrequent Access{iaAvailable ? "" : " (Workers only)"}
						</option>
						{stores.map((store) => (
							<option key={store.id} value={store.id}>
								{store.name}
							</option>
						))}
					</Select>
				</div>
				<label className="flex items-center gap-2 pb-2 text-sm font-medium text-neutral-900">
					<Checkbox
						checked={form.enabled}
						onChange={(event) => update({ enabled: event.target.checked })}
						disabled={busy}
					/>
					On
				</label>
				<div className="flex gap-2 pb-0.5">
					<Button size="sm" disabled={busy} onClick={() => void save()}>
						Save
					</Button>
					<Button
						size="sm"
						variant="outline"
						disabled={busy || !rule.enabled || isColdJobRunning(job)}
						onClick={() => void runNow()}
					>
						Run now
					</Button>
				</div>
			</div>
			{rule.objectClass === "mail" && (
				<p className="text-xs text-neutral-500">
					The raw envelope has no recorded size, so the minimum applies only to its attachments and large bodies.
				</p>
			)}
			{coldJobSummary(job) && <p className="text-sm text-neutral-500">{coldJobSummary(job)}</p>}
			{job?.lastError && <p className="text-sm text-red-600">{job.lastError}</p>}
			{error && (
				<p role="alert" className="text-sm text-red-600">
					{error}
				</p>
			)}
		</li>
	);
}

/** Admin → Storage: per-class age rules that move old objects to R2 Infrequent Access or a second store (§10). */
export function ColdStorageCard({ overview }: { overview: StorageOverview }) {
	const queryClient = useQueryClient();
	const cold = useQuery({
		queryKey: COLD_QUERY_KEY,
		queryFn: fetchCold,
		refetchInterval: (query) => (query.state.data?.jobs.some(isColdJobRunning) ? 3000 : false),
	});
	const refresh = () => void queryClient.invalidateQueries({ queryKey: COLD_QUERY_KEY });
	const data = cold.data;
	const jobFor = (objectClass: RoutableClass) => data?.jobs.find((job) => job.objectClass === objectClass);

	return (
		<section aria-labelledby="storage-cold" className="rounded-xl border border-neutral-200 bg-white p-5">
			<h2 id="storage-cold" className="text-lg font-semibold text-neutral-900">
				Cold storage
			</h2>
			<p className="mt-1 text-sm text-neutral-500">
				Move old mail, attachments and Drive files to cheaper storage. Opening a moved item needs no extra step. R2
				Infrequent Access costs less to keep but bills every read and keeps objects at least 30 days, so it rarely pays
				off for small, often-read mail; a second store has no minimum but needs its own copy and read cost.
			</p>
			{cold.isError && (
				<p className="mt-3 text-sm text-red-600">{errorText(cold.error, "Could not load cold storage")}</p>
			)}
			{data && (
				<ul className="mt-2 divide-y divide-neutral-200">
					{data.rules.map((rule) => (
						<ColdRuleRow
							key={rule.objectClass}
							overview={overview}
							rule={rule}
							job={jobFor(rule.objectClass)}
							iaAvailable={data.iaAvailable}
							onChanged={refresh}
						/>
					))}
				</ul>
			)}
		</section>
	);
}

"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { requestConfirmation } from "@/components/ui/confirm-dialog-utils";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MAX_GRACE_DAYS, MIN_GRACE_DAYS } from "@/lib/storage/cold-leftovers-utils";
import type { LeftoverRunResult, StorageOverview } from "./types";
import { graceFormToBody, keptReasonsText, leftoverRunText, remainingText, type GraceForm } from "./leftovers-utils";
import { errorText, storageRequest } from "./utils";

/** Runs one manual cleanup pass over `storeId` (null: every store) after the admin confirms it. */
function useDeleteLeftovers(storeId: string | null, label: string, graceDays: number, onDone: () => void) {
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	async function run() {
		const confirmed = await requestConfirmation({
			title: `Delete leftover copies ${storeId ? `on ${label}` : "on every store"}?`,
			description: `Kite deletes leftover copies of cold storage moves that are past the ${graceDays}-day grace period, one at a time: each only after it has confirmed another readable copy, or that nothing uses the object and no backup you keep could bring it back. Anything it cannot prove safe stays, with the reason shown here. This cannot be undone.`,
			confirmLabel: "Delete leftovers",
		});
		if (!confirmed) return;
		setBusy(true);
		setError(null);
		setResult(null);
		try {
			const run = await storageRequest<LeftoverRunResult>("/leftovers", {
				method: "POST",
				json: storeId ? { storeId } : {},
			});
			setResult(`${leftoverRunText(run)} ${remainingText(run.remaining, !!storeId)}`);
			onDone();
		} catch (caught) {
			setError(errorText(caught, "Could not delete the leftovers"));
		} finally {
			setBusy(false);
		}
	}

	return { busy, result, error, run };
}

/**
 * "Delete leftovers" for one store (or all of them) while `count` are tracked there, with what the last run did
 * right under it; the result stays after the count drops to zero, so the admin sees it.
 */
export function DeleteLeftovers({
	storeId,
	label,
	count,
	graceDays,
	onDone,
	variant = "outline",
}: {
	storeId: string | null;
	label: string;
	count: number;
	graceDays: number;
	onDone: () => void;
	variant?: "outline" | "default";
}) {
	const { busy, result, error, run } = useDeleteLeftovers(storeId, label, graceDays, onDone);
	if (!(count > 0) && !result && !error) return null;
	return (
		<div className="space-y-1">
			{count > 0 && (
				<Button size="sm" variant={variant} disabled={busy} onClick={() => void run()}>
					{busy ? "Deleting…" : "Delete leftovers"}
				</Button>
			)}
			{result && (
				<p role="status" className="text-sm text-neutral-600">
					{result}
				</p>
			)}
			{error && (
				<p role="alert" className="text-sm text-red-600">
					{error}
				</p>
			)}
		</div>
	);
}

function AutomaticCleanupForm({ overview, onChanged }: { overview: StorageOverview; onChanged: () => void }) {
	const { settings } = overview.leftovers;
	const [form, setForm] = useState<GraceForm>({ automatic: settings.automatic, graceDays: String(settings.graceDays) });
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);

	async function save() {
		const built = graceFormToBody(form, { min: MIN_GRACE_DAYS, max: MAX_GRACE_DAYS });
		if ("error" in built) return setError(built.error);
		setBusy(true);
		setError(null);
		setSaved(false);
		try {
			await storageRequest("/leftovers", { method: "PUT", json: built.body });
			setSaved(true);
			onChanged();
		} catch (caught) {
			setError(errorText(caught, "Could not save the cleanup settings"));
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="space-y-2">
			<div className="flex flex-wrap items-end gap-3">
				<div className="space-y-1.5">
					<Label htmlFor="leftover-grace">Grace period (days)</Label>
					<Input
						id="leftover-grace"
						type="number"
						min={MIN_GRACE_DAYS}
						max={MAX_GRACE_DAYS}
						inputMode="numeric"
						value={form.graceDays}
						onChange={(event) => setForm((current) => ({ ...current, graceDays: event.target.value }))}
						disabled={busy}
						className="max-w-28"
					/>
				</div>
				<label className="flex items-center gap-2 pb-2 text-sm font-medium text-neutral-900">
					<Checkbox
						checked={form.automatic}
						onChange={(event) => setForm((current) => ({ ...current, automatic: event.target.checked }))}
						disabled={busy}
					/>
					Delete leftovers automatically
				</label>
				<Button size="sm" disabled={busy} onClick={() => void save()} className="mb-0.5">
					Save
				</Button>
			</div>
			<p className="text-xs text-neutral-500">
				A copy is only looked at once it has been a leftover for the grace period. The automatic cleanup runs every five
				minutes, a few copies at a time, with the same checks as Delete leftovers.
			</p>
			{saved && (
				<p role="status" className="text-sm text-neutral-600">
					Saved.
				</p>
			)}
			{error && (
				<p role="alert" className="text-sm text-red-600">
					{error}
				</p>
			)}
		</div>
	);
}

/**
 * Admin → Storage: copies cold storage moves left behind (a superseded copy, the bytes of mail deleted mid-move),
 * with the manual cleanup for every store and the optional automatic one, off by default.
 */
export function LeftoversCard({ overview, onChanged }: { overview: StorageOverview; onChanged: () => void }) {
	const { leftovers } = overview;
	if (!leftovers.available) return null;
	const kept = keptReasonsText(leftovers.kept);
	return (
		<section aria-labelledby="storage-leftovers" className="rounded-xl border border-neutral-200 bg-white p-5">
			<h2 id="storage-leftovers" className="text-lg font-semibold text-neutral-900">
				Leftover copies
			</h2>
			<p className="mt-1 text-sm text-neutral-500">
				Copies cold storage moves left behind that nothing reads any more. They only cost storage; Kite never deletes
				one while it may still be needed, and keeps any it cannot prove safe.
			</p>
			<div className="mt-3 flex flex-wrap items-start justify-between gap-3">
				<div className="space-y-1 text-sm text-neutral-700">
					<p>
						{leftovers.total.toLocaleString()} {leftovers.total === 1 ? "leftover copy" : "leftover copies"} tracked,{" "}
						{leftovers.due.toLocaleString()} past the grace period.
					</p>
					{kept && <p className="text-neutral-500">Kept last time: {kept}.</p>}
					{leftovers.lastRun && (
						<p className="text-neutral-500">
							Last run ({leftovers.lastRun.trigger === "automatic" ? "automatic" : "by hand"},{" "}
							{new Date(leftovers.lastRun.at).toLocaleString()}): {leftoverRunText(leftovers.lastRun)}
						</p>
					)}
				</div>
				<DeleteLeftovers
					storeId={null}
					label="every store"
					count={leftovers.total}
					graceDays={leftovers.settings.graceDays}
					onDone={onChanged}
					variant="default"
				/>
			</div>
			<div className="mt-4 border-t border-neutral-200 pt-4">
				<AutomaticCleanupForm overview={overview} onChanged={onChanged} />
			</div>
		</section>
	);
}

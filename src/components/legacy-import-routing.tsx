"use client";

import { useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import type { LegacyRoutingResult, LegacyRoutingStatus } from "@/lib/legacy-import/types";
import { describeLegacyRoutes } from "./legacy-import-card-utils";
import { fetchLegacyRouting, moveLegacyRouting } from "./legacy-import-client";

const SHOWN_ROUTES = 6;

function RoutingDetails({ status }: { status: LegacyRoutingStatus }) {
	if (!status.configured)
		return (
			<p className="text-sm text-neutral-600">
				Add a <span className="font-mono">CF_TOKEN</span> secret to this Worker to read and change Email Routing.
			</p>
		);
	if (!status.routes.length)
		return (
			<p className="flex items-center gap-2 text-sm text-neutral-700">
				<CheckCircle2 className="h-4 w-4 shrink-0 text-green-600" />
				All mail is delivered to {status.workerName}.
			</p>
		);
	const hidden = status.routes.length - SHOWN_ROUTES;
	return (
		<div className="space-y-1 text-sm text-neutral-700">
			<p>{describeLegacyRoutes(status.routes)} still deliver to the old Worker:</p>
			<p className="text-neutral-500">
				{status.routes
					.slice(0, SHOWN_ROUTES)
					.map((route) => (route.address === "*" ? `everything else at ${route.hostname}` : route.address))
					.join(", ")}
				{hidden > 0 ? `, and ${hidden} more` : ""}
			</p>
		</div>
	);
}

/** Moves Email Routing rules from the old Worker to this one, so new mail arrives here. */
export function LegacyImportRouting() {
	const [status, setStatus] = useState<LegacyRoutingStatus | null>(null);
	const [result, setResult] = useState<LegacyRoutingResult | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const confirm = useConfirm();

	async function check() {
		setBusy(true);
		setError("");
		try {
			setStatus(await fetchLegacyRouting());
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "Could not read Email Routing");
		} finally {
			setBusy(false);
		}
	}

	async function move() {
		if (!status) return;
		const confirmed = await confirm({
			title: `Deliver new mail to ${status.workerName}?`,
			description:
				"Email Routing will send these addresses to this install instead of the old one. Afterwards, run Copy new mail to bring over anything that reached the old install in the meantime.",
			confirmLabel: "Move mail routing",
			destructive: false,
		});
		if (!confirmed) return;
		setBusy(true);
		setError("");
		try {
			const moved = await moveLegacyRouting();
			setResult(moved);
			setStatus(moved.status);
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "Could not update Email Routing");
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="space-y-3 rounded-2xl border border-neutral-100 px-4 py-4" data-testid="legacy-import-routing">
			<div className="flex items-center gap-3">
				<p className="text-sm font-medium text-neutral-900">Mail routing</p>
				{!status?.routes.length ? (
					<Button type="button" variant="outline" size="sm" className="ml-auto" disabled={busy} onClick={check}>
						{busy ? "Checking..." : status ? "Check again" : "Check Email Routing"}
					</Button>
				) : (
					<Button type="button" size="sm" className="ml-auto" disabled={busy} onClick={move}>
						{busy ? "Moving..." : `Move to ${status.workerName}`}
					</Button>
				)}
			</div>
			{status ? (
				<RoutingDetails status={status} />
			) : (
				<p className="text-sm text-neutral-600">See which addresses still deliver to the old Worker.</p>
			)}
			{status?.error && status.configured && <p className="text-sm text-amber-700">{status.error}</p>}
			{result && (
				<p className="text-sm text-neutral-700">
					Moved {result.updated} {result.updated === 1 ? "rule" : "rules"}.
					{result.failed.length
						? ` ${result.failed.length} could not be moved: ${result.failed.map((item) => `${item.route.address} (${item.error})`).join("; ")}`
						: ""}
				</p>
			)}
			{error && <p className="text-sm text-red-600">{error}</p>}
		</div>
	);
}

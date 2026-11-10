"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";
import { requestConfirmation } from "@/components/ui/confirm-dialog-utils";
import { SettingRow } from "@/components/ui/page";
import { Switch } from "@/components/ui/switch";
import { authFetch } from "@/lib/auth/client";
import type { SemanticSearchStatus } from "./semantic-search-admin-types";

const QUERY_KEY = ["semantic-search-admin"];

async function fetchStatus(): Promise<SemanticSearchStatus> {
	const response = await authFetch("/api/admin/semantic-search");
	if (!response.ok) throw new Error(`Could not load search by meaning (${response.status})`);
	return (await response.json()) as SemanticSearchStatus;
}

async function putSettings(body: Record<string, unknown>): Promise<SemanticSearchStatus> {
	const response = await authFetch("/api/admin/semantic-search", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!response.ok) {
		const data = (await response.json().catch(() => ({}))) as { error?: string };
		throw new Error(data.error ?? `Request failed (${response.status})`);
	}
	return (await response.json()) as SemanticSearchStatus;
}

async function postAction(action: "rebuild" | "clear_stale_vectors") {
	const response = await authFetch("/api/admin/semantic-search", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ action }),
	});
	if (!response.ok) {
		const data = (await response.json().catch(() => ({}))) as { error?: string };
		throw new Error(data.error ?? `Request failed (${response.status})`);
	}
	return (await response.json()) as { supported?: boolean; removed?: number };
}

function formatUsd(value: number | null): string {
	if (value === null) return "unknown";
	return value < 0.01 && value > 0 ? "< $0.01" : `$${value.toFixed(2)}`;
}

function ProgressStats({ status }: { status: SemanticSearchStatus }) {
	const { counts } = status;
	const remaining = counts.pending + counts.running + counts.eligibleUnqueued;
	const total = remaining + counts.indexed + counts.skipped + counts.failed;
	const stats: { label: string; value: number }[] = [
		{ label: "Indexed", value: counts.indexed },
		{ label: "Remaining", value: remaining },
		{ label: "Skipped", value: counts.skipped },
		{ label: "Failed", value: counts.failed },
	];
	return (
		<div className="space-y-2">
			<dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
				{stats.map((stat) => (
					<div key={stat.label} className="rounded-lg border border-neutral-200 p-3">
						<dt className="text-xs text-neutral-500">{stat.label}</dt>
						<dd className="mt-1 text-lg font-semibold text-neutral-900 tabular-nums">{stat.value.toLocaleString()}</dd>
					</div>
				))}
			</dl>
			{total > 0 && remaining > 0 && (
				<div
					role="progressbar"
					aria-label="Search by meaning indexing progress"
					aria-valuemin={0}
					aria-valuemax={total}
					aria-valuenow={total - remaining}
					className="h-1.5 overflow-hidden rounded-full bg-blue-100"
				>
					<div
						className="h-full rounded-full bg-blue-600 transition-[width]"
						style={{ width: `${((total - remaining) / total) * 100}%` }}
					/>
				</div>
			)}
			<p className="text-xs text-neutral-500">
				Estimated cost to finish: {formatUsd(status.estimatedCostUsd)} with Workers AI&apos;s bge-m3 rate.
			</p>
		</div>
	);
}

/** Admin -> Agent -> Search by meaning (`docs/specs/semantic-search.md`). */
export function SemanticSearchAdminSettings() {
	const queryClient = useQueryClient();
	const status = useQuery({ queryKey: QUERY_KEY, queryFn: fetchStatus, refetchInterval: 10_000 });
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [baseUrl, setBaseUrl] = useState("");
	const [apiKey, setApiKey] = useState("");

	const refresh = () => void queryClient.invalidateQueries({ queryKey: QUERY_KEY });

	async function save(body: Record<string, unknown>) {
		setBusy(true);
		setError(null);
		try {
			const next = await putSettings(body);
			queryClient.setQueryData(QUERY_KEY, next);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : "Could not save");
		} finally {
			setBusy(false);
		}
	}

	async function act(action: "rebuild" | "clear_stale_vectors") {
		setBusy(true);
		setError(null);
		try {
			await postAction(action);
			refresh();
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : "Could not update search by meaning");
		} finally {
			setBusy(false);
		}
	}

	const data = status.data;
	return (
		<Card data-testid="semantic-search-admin-settings">
			<CardHeader>
				<CardTitle>Search by meaning</CardTitle>
				<CardDescription>
					Find mail by what it means, not only the words in it. Embeds mail with Workers AI and searches it with
					Vectorize, merged with keyword search.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				{status.isError && (
					<Notice tone="error">
						{status.error instanceof Error ? status.error.message : "Could not load search by meaning"}
					</Notice>
				)}
				{data && !data.ready && <Notice>Apply the pending database update to use search by meaning.</Notice>}
				{data && (
					<>
						<SettingRow
							label="Enable search by meaning"
							description="Off by default. Turning it on starts indexing eligible mail; query text is sent to the embedding provider."
							control={
								<Switch
									checked={data.settings.enabled}
									disabled={!data.ready || busy}
									onCheckedChange={async (checked) => {
										if (
											!checked &&
											!(await requestConfirmation({
												title: "Turn off search by meaning?",
												description:
													"This deletes the whole index. Turning it on again embeds all mail again, which costs money.",
												confirmLabel: "Turn off",
											}))
										)
											return;
										await save({ enabled: checked });
									}}
									aria-label="Enable search by meaning"
								/>
							}
						/>
						{data.settings.enabled && (
							<>
								<ProgressStats status={data} />
								<SettingRow
									label="Pause the backfill"
									description="Live mail keeps being indexed; only the backfill of older mail pauses."
									control={
										<Switch
											checked={data.settings.backfillPaused}
											disabled={busy}
											onCheckedChange={(checked) => void save({ backfillPaused: checked })}
											aria-label="Pause the backfill"
										/>
									}
								/>
								<div className="space-y-1">
									<Label htmlFor="semantic-cap-share">Backfill&apos;s share of the daily spend cap</Label>
									<div className="flex items-center gap-2">
										<Input
											id="semantic-cap-share"
											type="number"
											min={0}
											max={100}
											className="w-24"
											defaultValue={data.settings.backfillCapShare}
											disabled={busy}
											onBlur={(event) => {
												const raw = event.currentTarget.value.trim();
												const value = Math.min(100, Math.max(0, Math.round(Number(raw))));
												if (raw === "" || !Number.isFinite(value)) {
													event.currentTarget.value = String(data.settings.backfillCapShare);
													return;
												}
												if (value !== data.settings.backfillCapShare) void save({ backfillCapShare: value });
											}}
										/>
										<span className="text-sm text-neutral-500">%</span>
									</div>
								</div>
								<div className="space-y-2 border-t border-neutral-200 pt-4">
									<p className="text-sm font-medium text-neutral-800">Node embedding provider</p>
									<p className="text-xs text-neutral-500">
										Only used off Workers, without Cloudflare account credentials: an OpenAI-compatible endpoint serving
										bge-m3. Sending mail text to it needs the external-provider opt-in above.
									</p>
									<Input
										aria-label="Embedding endpoint base URL"
										placeholder={data.settings.compatibleBaseUrl ?? "https://embeddings.example.com/v1"}
										value={baseUrl}
										onChange={(event) => setBaseUrl(event.currentTarget.value)}
										disabled={busy}
									/>
									<Input
										aria-label="Embedding endpoint API key"
										type="password"
										placeholder="API key (leave blank to keep the saved one)"
										value={apiKey}
										onChange={(event) => setApiKey(event.currentTarget.value)}
										disabled={busy}
									/>
									<Button
										size="sm"
										variant="outline"
										disabled={busy}
										onClick={() =>
											void save({
												embeddingProvider: "compatible",
												...(baseUrl ? { compatibleBaseUrl: baseUrl } : {}),
												...(apiKey ? { compatibleApiKey: apiKey } : {}),
											})
										}
									>
										Save endpoint
									</Button>
								</div>
								<div className="flex flex-wrap gap-2 border-t border-neutral-200 pt-4">
									<Button
										size="sm"
										variant="outline"
										disabled={busy}
										onClick={async () => {
											const confirmed = await requestConfirmation({
												title: "Rebuild the index?",
												description:
													"Every row goes back to pending. Content that has not changed is not re-embedded, so this usually costs little.",
												confirmLabel: "Rebuild index",
											});
											if (confirmed) await act("rebuild");
										}}
									>
										Rebuild index
									</Button>
									<Button
										size="sm"
										variant="outline"
										disabled={busy}
										onClick={async () => {
											const confirmed = await requestConfirmation({
												title: "Clear stale vectors?",
												description:
													"Removes vectors the index no longer has a row for, such as orphans left after a restore into a different database. Unavailable on Vectorize, which cannot list its own vectors.",
												confirmLabel: "Clear stale vectors",
											});
											if (confirmed) await act("clear_stale_vectors");
										}}
									>
										Clear stale vectors
									</Button>
								</div>
							</>
						)}
					</>
				)}
				{error && (
					<p role="alert" className="text-sm text-red-600">
						{error}
					</p>
				)}
			</CardContent>
		</Card>
	);
}

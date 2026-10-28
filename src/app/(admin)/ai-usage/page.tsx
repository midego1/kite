"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { AiUsageResponse } from "./types";
import { fetchAiUsage, formatEstimatedUsd, formatTokenCount, formatUsageDate, formatUsageProvider } from "./utils";
import { UsageChart } from "./usage-chart";

export default function AiUsagePage() {
	const [data, setData] = useState<AiUsageResponse | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loadingPage, setLoadingPage] = useState(false);

	useEffect(() => {
		let active = true;
		void fetchAiUsage(1)
			.then((result) => {
				if (active) setData(result);
			})
			.catch((cause) => {
				if (active) setError(cause instanceof Error ? cause.message : "Could not load AI usage");
			});
		return () => {
			active = false;
		};
	}, []);

	const totals = data?.totals;
	return (
		<div className="space-y-6">
			<div className="flex items-start justify-between gap-4">
				<div>
					<h1 className="text-xl font-semibold tracking-tight text-neutral-900">AI Usage</h1>
					<p className="mt-1 text-sm text-neutral-500">Requests recorded since usage tracking was added.</p>
				</div>
				<Button asChild variant="outline" className="shrink-0">
					<Link href="/agent">Back to Agent</Link>
				</Button>
			</div>
			{error && (
				<p role="alert" className="text-sm text-red-700">
					{error}
				</p>
			)}
			<div className="grid gap-4 sm:grid-cols-3">
				<section className="rounded-xl border border-neutral-200 bg-white p-5">
					<p className="text-sm text-neutral-500">Total tokens</p>
					<p className="mt-2 text-2xl font-semibold text-neutral-900">
						{totals ? formatTokenCount(totals.totalTokens) : "—"}
					</p>
				</section>
				<section className="rounded-xl border border-neutral-200 bg-white p-5">
					<p className="text-sm text-neutral-500">Total requests</p>
					<p className="mt-2 text-2xl font-semibold text-neutral-900">
						{totals ? formatTokenCount(totals.requests) : "—"}
					</p>
				</section>
				<section className="rounded-xl border border-neutral-200 bg-white p-5">
					<p className="text-sm text-neutral-500">Estimated spend</p>
					<p className="mt-2 text-2xl font-semibold text-neutral-900">
						{totals && totals.pricedRequests ? formatEstimatedUsd(totals.costUsdMicros) : "—"}
					</p>
					{totals && totals.pricedRequests < totals.requests && (
						<p className="mt-1 text-xs text-neutral-500">
							{formatTokenCount(totals.requests - totals.pricedRequests)} requests have no rate.
						</p>
					)}
				</section>
			</div>
			<UsageChart daily={data?.daily ?? []} timeZone={data?.timeZone} />
			<section
				role="region"
				tabIndex={0}
				aria-label="AI usage"
				className="overflow-x-auto rounded-xl border border-neutral-200 bg-white"
				aria-busy={loadingPage}
			>
				<table className="w-full min-w-[850px] text-left text-sm">
					<thead className="border-b border-neutral-200 bg-[#f6f8fc] text-xs font-medium text-neutral-500">
						<tr>
							<th scope="col" className="px-4 py-3">
								Date & time
							</th>
							<th scope="col" className="px-4 py-3">
								Model
							</th>
							<th scope="col" className="px-4 py-3">
								Provider
							</th>
							<th scope="col" className="px-4 py-3 text-right">
								Input tokens
							</th>
							<th scope="col" className="px-4 py-3 text-right">
								Output tokens
							</th>
							<th scope="col" className="px-4 py-3 text-right">
								Spending
							</th>
						</tr>
					</thead>
					<tbody className="divide-y divide-neutral-200">
						{data?.rows.map((row) => (
							<tr key={row.id}>
								<td className="whitespace-nowrap px-4 py-3 text-neutral-600">{formatUsageDate(row.createdAt)}</td>
								<td className="max-w-56 break-all px-4 py-3">{row.model}</td>
								<td className="px-4 py-3">{formatUsageProvider(row.provider)}</td>
								<td className="px-4 py-3 text-right tabular-nums">{formatTokenCount(row.inputTokens)}</td>
								<td className="px-4 py-3 text-right tabular-nums">{formatTokenCount(row.outputTokens)}</td>
								<td className="px-4 py-3 text-right tabular-nums">{formatEstimatedUsd(row.costUsdMicros)}</td>
							</tr>
						))}
						{data && data.rows.length === 0 && (
							<tr>
								<td colSpan={6} className="px-4 py-8 text-center text-neutral-500">
									No AI usage recorded yet.
								</td>
							</tr>
						)}
						{!data && !error && (
							<tr>
								<td colSpan={6} className="px-4 py-8 text-center text-neutral-500">
									Loading usage…
								</td>
							</tr>
						)}
					</tbody>
				</table>
			</section>
			{data && (
				<div className="flex items-center justify-end gap-3 text-sm text-neutral-600">
					<span>
						Page {data.page} of {data.totalPages} · {data.pageSize} per page
					</span>
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={loadingPage || data.page <= 1}
						onClick={() => {
							setLoadingPage(true);
							setError(null);
							void fetchAiUsage(data.page - 1)
								.then(setData)
								.catch((cause) => setError(cause instanceof Error ? cause.message : "Could not load usage page"))
								.finally(() => setLoadingPage(false));
						}}
					>
						Previous
					</Button>
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={loadingPage || data.page >= data.totalPages}
						onClick={() => {
							setLoadingPage(true);
							setError(null);
							void fetchAiUsage(data.page + 1)
								.then(setData)
								.catch((cause) => setError(cause instanceof Error ? cause.message : "Could not load usage page"))
								.finally(() => setLoadingPage(false));
						}}
					>
						Next
					</Button>
				</div>
			)}
			<p className="text-xs text-neutral-500">
				Spending is estimated from the per-model rates saved in Agent settings. A dash means no rate or token count was
				available.
			</p>
		</div>
	);
}

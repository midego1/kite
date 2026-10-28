"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { aiErrorMessage } from "@/lib/agent/ai-error-utils";
import type { RecentAiError } from "@/lib/agent/ai-error-types";
import { authFetch } from "@/lib/auth/client";

function seconds(ms: number | null): string | null {
	return ms === null ? null : `${(ms / 1000).toFixed(1)} s`;
}

/** Duration, tokens, HTTP status and finish reason, whichever the failure has. */
function measurements(row: RecentAiError): string {
	return [
		seconds(row.durationMs),
		row.inputTokens !== null || row.outputTokens !== null
			? `${row.inputTokens ?? 0} in / ${row.outputTokens ?? 0} out tokens`
			: null,
		row.status ? `HTTP ${row.status}` : null,
		row.finishReason ? `finish: ${row.finishReason}` : null,
	]
		.filter(Boolean)
		.join(" · ");
}

/**
 * Admin → Agent's list of the last 20 failed AI requests, so the primary admin can see what failed without server
 * access: when, which feature, the code and what it means, the model and provider, and the numbers. No content.
 */
export function RecentAiErrors() {
	const [rows, setRows] = useState<RecentAiError[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const load = useCallback(async () => {
		setError(null);
		try {
			const response = await authFetch("/api/admin/agent/errors", { cache: "no-store" });
			const data = (await response.json()) as { errors?: RecentAiError[]; error?: string };
			if (!response.ok) throw new Error(data.error || "Could not load recent AI errors");
			setRows(data.errors ?? []);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not load recent AI errors");
		}
	}, []);
	useEffect(() => {
		// The first load starts when the page opens; setState runs after the request, never during render.
		// eslint-disable-next-line react-hooks/set-state-in-effect
		void load();
	}, [load]);

	return (
		<Card role="region" aria-label="Recent AI errors">
			<CardHeader>
				<div className="flex items-start justify-between gap-4">
					<div>
						<CardTitle className="flex items-center gap-2">
							<TriangleAlert className="h-5 w-5" />
							Recent AI errors
						</CardTitle>
						<CardDescription className="mt-1.5">
							The last 20 AI requests that failed, from every feature. Only codes, models and numbers are kept, never
							what was asked or answered.
						</CardDescription>
					</div>
					<Button type="button" variant="outline" size="sm" onClick={() => void load()} className="gap-1.5">
						<RefreshCw aria-hidden className="h-3.5 w-3.5" />
						Refresh
					</Button>
				</div>
			</CardHeader>
			<CardContent className="pt-4">
				{error && (
					<p role="alert" className="text-sm text-red-700">
						{error}
					</p>
				)}
				{!error && rows === null && <p className="text-sm text-neutral-500">Loading…</p>}
				{!error && rows?.length === 0 && <p className="text-sm text-neutral-500">No AI errors recorded.</p>}
				{!!rows?.length && (
					<ul className="divide-y divide-neutral-200 text-sm">
						{rows.map((row) => (
							<li key={row.id} data-ai-error-row={row.code} className="space-y-0.5 py-3">
								<div className="flex flex-wrap items-baseline gap-x-2">
									<span className="font-medium text-neutral-900">{row.featureLabel}</span>
									<code className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-700">{row.code}</code>
									<span className="ml-auto text-xs text-neutral-500">{new Date(row.at).toLocaleString()}</span>
								</div>
								<p className="text-neutral-700">{aiErrorMessage(row.code, { status: row.status })}</p>
								<p className="break-all text-xs text-neutral-500">
									{[row.model ?? "No model chosen", row.provider, row.mailbox, row.user].filter(Boolean).join(" · ")}
								</p>
								{measurements(row) && <p className="text-xs text-neutral-500">{measurements(row)}</p>}
							</li>
						))}
					</ul>
				)}
			</CardContent>
		</Card>
	);
}

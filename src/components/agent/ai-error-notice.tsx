"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useCurrentUser } from "@/hooks/use-current-user";
import { AI_FEATURE_LABELS, type AiErrorBody } from "@/lib/agent/ai-error-utils";
import { cn } from "@/lib/utils";

type AiErrorNoticeProps = {
	/** The sentence to show; the server's `error` for an AI failure, or any other message. */
	message: string;
	/** The failure's code and details, when the server sent them. */
	error?: AiErrorBody | null;
	/** Shown as Try again when retrying can help. */
	onRetry?: () => void;
	className?: string;
};

function formatTime(iso: string): string {
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/**
 * A failed AI request: the message (the only part read out as the alert), Try again where retrying can help, a link
 * to Admin → Agent for the primary admin when a setting is the cause, and a Details disclosure with the code, the
 * model, the provider and the time. Never anything from the prompt or the answer.
 */
export function AiErrorNotice({ message, error, onRetry, className }: AiErrorNoticeProps) {
	const user = useCurrentUser();
	const details = error?.details ?? null;
	const retry = onRetry && (details ? details.retryable : true);
	const adminHint = !!details?.config && user?.role === "admin" && user.isPrimaryAdmin;
	const rows: [string, string][] = details
		? [
				["Code", details.code],
				["Feature", AI_FEATURE_LABELS[details.feature]],
				["Model", details.model ?? "Not chosen yet"],
				["Provider", details.provider ?? "Not chosen yet"],
				...(details.status ? ([["HTTP status", String(details.status)]] as [string, string][]) : []),
				["Time", formatTime(details.at)],
			]
		: [];
	return (
		<div className={cn("space-y-1.5", className)} data-ai-error={details?.code}>
			<p role="alert" className="break-words text-red-700">
				{message}
			</p>
			{(retry || adminHint || details) && (
				<div className="flex flex-wrap items-start gap-x-3 gap-y-1.5 text-xs">
					{retry && (
						<Button type="button" size="sm" variant="outline" onClick={onRetry}>
							Try again
						</Button>
					)}
					{adminHint && (
						<Link href="/agent" className="self-center font-medium text-blue-700 hover:underline">
							Open Admin → Agent
						</Link>
					)}
					{details && (
						<details className="self-center text-neutral-500">
							<summary className="cursor-pointer select-none">Details</summary>
							<dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
								{rows.map(([label, value]) => (
									<div key={label} className="contents">
										<dt className="text-neutral-400">{label}</dt>
										<dd className="break-all text-neutral-700">{value}</dd>
									</div>
								))}
							</dl>
						</details>
					)}
				</div>
			)}
		</div>
	);
}

"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Notice } from "@/components/ui/notice";
import { Skeleton } from "@/components/ui/skeleton";
import type { AiFailureGroup, AiFailureReport } from "@/lib/agent/ai-failure-report-types";
import { authFetch } from "@/lib/auth/client";
import { useAssistantToggle } from "./assistant-open-state";
import { requestAssistantPrompt } from "./assistant-prompt-request";

const REPORT_QUERY = ["admin-ai-failure-report"] as const;

async function fetchReport(): Promise<AiFailureReport> {
	const response = await authFetch("/api/admin/agent/errors/report", { cache: "no-store" });
	if (!response.ok) throw new Error(`Could not load the failed AI requests (${response.status})`);
	return (await response.json()) as AiFailureReport;
}

const time = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });

function FailureGroup({ group }: { group: AiFailureGroup }) {
	const models = group.models
		.map(
			(entry) =>
				`${[entry.providerLabel, entry.model].filter(Boolean).join(" · ") || "No model chosen"} (${entry.count})`,
		)
		.join(", ");
	return (
		<li data-ai-failure-group={group.code} className="space-y-2 rounded-lg border border-neutral-200 p-3 text-sm">
			<div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
				<code className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-700">{group.code}</code>
				<span className="font-medium text-neutral-900">
					{group.count} {group.count === 1 ? "failure" : "failures"}
				</span>
				<span className="text-xs text-neutral-500 sm:ml-auto">
					{group.count === 1 ? time(group.lastAt) : `${time(group.firstAt)} – ${time(group.lastAt)}`}
				</span>
			</div>
			<p className="text-neutral-900">{group.cause}</p>
			<p className="text-neutral-700">
				<span className="font-medium">Fix: </span>
				{group.fix}
			</p>
			{group.link && (
				<Link
					href={group.link.href}
					className="inline-block font-medium text-blue-700 underline underline-offset-2 hover:opacity-80"
				>
					{group.link.label}
				</Link>
			)}
			<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-neutral-600">
				<dt className="text-neutral-500">Features</dt>
				<dd className="min-w-0 break-words">
					{group.features.map((entry) => `${entry.label} (${entry.count})`).join(", ")}
				</dd>
				<dt className="text-neutral-500">Model</dt>
				<dd className="min-w-0 break-all">{models}</dd>
				{group.statuses.length > 0 && (
					<>
						<dt className="text-neutral-500">HTTP</dt>
						<dd>{group.statuses.join(", ")}</dd>
					</>
				)}
				<dt className="text-neutral-500">Latest</dt>
				<dd className="min-w-0 break-words">{group.latestMessage}</dd>
			</dl>
		</li>
	);
}

/** Ask AI, or why it can't run here and where to fix that. */
function AskAi({ report, onAsk }: { report: AiFailureReport; onAsk: () => void }) {
	if (!report.assistant.available)
		return (
			<Notice tone="info" title="Ask AI is not available" data-testid="ai-failures-ask-unavailable">
				{report.assistant.reason}{" "}
				{report.assistant.link && <Link href={report.assistant.link.href}>{report.assistant.link.label}</Link>}
			</Notice>
		);
	return (
		<div className="flex flex-wrap items-center gap-3">
			<Button type="button" onClick={onAsk} className="gap-1.5">
				<Sparkles aria-hidden className="h-4 w-4" />
				Ask AI
			</Button>
			<p className="min-w-0 flex-1 text-xs text-neutral-500">
				Opens the assistant with this summary (codes and counts, no email) for you to send.
			</p>
		</div>
	);
}

/**
 * The Why? of "N AI requests failed": the last day's failures grouped by cause with a fix and a settings link each,
 * worked out by Kite without asking a model, and Ask AI to talk it through with the assistant. Primary admin only,
 * like the item it explains.
 */
export function AiFailuresWhy() {
	const [open, setOpen] = useState(false);
	const router = useRouter();
	const assistant = useAssistantToggle();
	const report = useQuery({ queryKey: REPORT_QUERY, queryFn: fetchReport, enabled: open, staleTime: 0, retry: false });

	const ask = () => {
		if (!report.data) return;
		requestAssistantPrompt(report.data.prompt);
		setOpen(false);
		// Inside the mailbox the layout opens the assistant; elsewhere the mailbox opens it on arrival.
		if (!assistant?.available) router.push("/inbox");
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<button
				type="button"
				onClick={() => setOpen(true)}
				aria-haspopup="dialog"
				className="text-sm font-medium underline underline-offset-2 hover:opacity-80"
			>
				Why?
			</button>
			<DialogContent
				className="flex max-h-[calc(100vh-4rem)] w-[min(640px,calc(100vw-32px))] flex-col"
				data-testid="ai-failures-why"
			>
				<DialogHeader>
					<DialogTitle>Why AI requests failed</DialogTitle>
					<DialogDescription>
						The last 24 hours, grouped by cause. Kite works this out from its own records without asking an AI; no email
						content is kept.
					</DialogDescription>
				</DialogHeader>
				<div className="-mx-1 min-h-0 flex-1 space-y-4 overflow-y-auto px-1">
					{report.isLoading && <Skeleton className="h-32 w-full rounded-lg" />}
					{report.error && (
						<Notice tone="error">{report.error instanceof Error ? report.error.message : "Could not load"}</Notice>
					)}
					{report.data && report.data.groups.length === 0 && (
						<p className="text-sm text-neutral-600">No failed AI requests in the last 24 hours.</p>
					)}
					{report.data && report.data.groups.length > 0 && (
						<ul className="space-y-3" aria-label="Failures by cause">
							{report.data.groups.map((group) => (
								<FailureGroup key={group.code} group={group} />
							))}
						</ul>
					)}
				</div>
				{report.data && report.data.groups.length > 0 && (
					<div className="mt-4 space-y-3 border-t border-neutral-200 pt-4">
						<AskAi report={report.data} onAsk={ask} />
						<Link
							href="/agent#recent-ai-errors"
							className="inline-block text-sm text-neutral-600 underline underline-offset-2 hover:opacity-80"
						>
							See each request in Recent AI errors
						</Link>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}

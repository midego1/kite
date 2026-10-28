"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { RecordRefLink } from "@/components/modules/record-ref-link";
import { Button } from "@/components/ui/button";
import { formatMessageListTimestamp } from "@/components/messages/utils";
import { AGENT_SUGGESTION_EVENT, dispatchAgentSuggestionChanged } from "@/hooks/message-realtime-utils";
import { authFetch } from "@/lib/auth/client";
import type { ActivityAction, ActivityLoadState, ActivityResponse, ActivitySkippedJob } from "./agent-activity-types";
import {
	actionLabel,
	actionTarget,
	activityUrl,
	initiatorLabel,
	reasonText,
	showsUndo,
	statusLabel,
	undoDisabledReason,
} from "./agent-activity-utils";

async function errorMessage(response: Response, fallback: string): Promise<string> {
	const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
	return typeof body?.error === "string" ? body.error : fallback;
}

function useActivity(mailboxId: string) {
	const [loaded, setLoaded] = useState<{ mailboxId: string; value: ActivityLoadState } | null>(null);
	const [version, setVersion] = useState(0);
	const reload = useCallback(() => setVersion((current) => current + 1), []);

	useEffect(() => {
		const controller = new AbortController();
		void (async () => {
			try {
				const response = await authFetch(activityUrl(mailboxId), { signal: controller.signal });
				let value: ActivityLoadState;
				if (response.status === 404) value = { state: "no-access" };
				else if (!response.ok)
					value = { state: "error", message: await errorMessage(response, "Activity could not be loaded.") };
				else value = { state: "ready", data: (await response.json()) as ActivityResponse };
				if (!controller.signal.aborted) setLoaded({ mailboxId, value });
			} catch {
				if (!controller.signal.aborted)
					setLoaded({ mailboxId, value: { state: "error", message: "Activity could not be loaded." } });
			}
		})();
		return () => controller.abort();
	}, [mailboxId, version]);

	useEffect(() => {
		window.addEventListener(AGENT_SUGGESTION_EVENT, reload);
		return () => window.removeEventListener(AGENT_SUGGESTION_EVENT, reload);
	}, [reload]);

	const value: ActivityLoadState = loaded?.mailboxId === mailboxId ? loaded.value : { state: "loading" };
	return { value, reload };
}

function ActionRow({
	row,
	busy,
	onUndo,
}: {
	row: ActivityAction;
	busy: boolean;
	onUndo: (row: ActivityAction) => void;
}) {
	const target = actionTarget(row);
	const reason = reasonText(row.reason);
	const disabledReason = undoDisabledReason(row, new Date());
	const blocked = row.status === "blocked";
	return (
		<li
			className={`flex items-start gap-3 px-4 py-3 ${blocked ? "bg-neutral-50 text-neutral-500 opacity-70" : ""}`}
			data-activity-action={row.id}
			data-status={row.status}
		>
			<div className="min-w-0 flex-1 space-y-0.5">
				<p className={`text-sm ${blocked ? "text-neutral-500" : "text-neutral-900"}`}>
					<span className="font-medium" data-activity-initiator>
						{initiatorLabel(row.initiator)}
					</span>
					<span aria-hidden> · </span>
					<span data-activity-label>{actionLabel(row)}</span>
				</p>
				{target && (
					<RecordRefLink
						target={target}
						className="block truncate text-sm text-blue-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
						textClassName="block truncate text-sm text-neutral-600"
						data-activity-target=""
					/>
				)}
				{reason && (
					<p className="text-xs text-neutral-500" data-activity-reason>
						{reason}
					</p>
				)}
				<p className="text-xs text-neutral-500">
					<span data-activity-status>{statusLabel(row.status)}</span>
					<span aria-hidden> · </span>
					<time dateTime={row.createdAt}>{formatMessageListTimestamp(row.createdAt)}</time>
				</p>
			</div>
			{showsUndo(row) && (
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={!!disabledReason || busy}
					title={disabledReason ?? undefined}
					onClick={() => onUndo(row)}
				>
					Undo
				</Button>
			)}
		</li>
	);
}

function SkippedRow({ job }: { job: ActivitySkippedJob }) {
	return (
		<li className="px-4 py-3" data-activity-skipped={job.id}>
			<p className="text-sm text-neutral-900" data-activity-reason>
				{reasonText(job.reason) ?? "Skipped"}
			</p>
			<Link
				href={`/inbox/${encodeURIComponent(job.sourceMessageId)}`}
				className="block truncate text-sm text-blue-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
			>
				{job.subject || "(No subject)"}
			</Link>
			<time dateTime={job.createdAt} className="text-xs text-neutral-500">
				{formatMessageListTimestamp(job.createdAt)}
			</time>
		</li>
	);
}

const LIST_CLASS = "divide-y divide-neutral-200 overflow-hidden rounded-xl border border-neutral-200 bg-white";

function ActivityLists({
	data,
	busyId,
	onUndo,
}: {
	data: ActivityResponse;
	busyId: string | null;
	onUndo: (row: ActivityAction) => void;
}) {
	return (
		<>
			<section aria-labelledby="agent-activity-actions" className="space-y-2">
				<h3 id="agent-activity-actions" className="text-xs font-medium text-neutral-500">
					Actions
				</h3>
				{data.actions.length === 0 ? (
					<p className="rounded-xl border border-dashed border-neutral-300 px-4 py-8 text-center text-sm text-neutral-500">
						Kite has not done anything in this mailbox yet.
					</p>
				) : (
					<ul className={LIST_CLASS}>
						{data.actions.map((row) => (
							<ActionRow key={row.id} row={row} busy={busyId !== null} onUndo={onUndo} />
						))}
					</ul>
				)}
			</section>
			{data.skippedJobs.length > 0 && (
				<section aria-labelledby="agent-activity-skipped" className="space-y-2">
					<h3 id="agent-activity-skipped" className="text-xs font-medium text-neutral-500">
						Messages Kite did not read
					</h3>
					<ul className={LIST_CLASS}>
						{data.skippedJobs.map((job) => (
							<SkippedRow key={job.id} job={job} />
						))}
					</ul>
				</section>
			)}
		</>
	);
}

/** The mailbox's Kite audit log with Undo, and the recent messages automatic reading skipped. */
export function AgentActivity({ mailboxId }: { mailboxId: string }) {
	const { value, reload } = useActivity(mailboxId);
	const [busyId, setBusyId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	async function undo(row: ActivityAction) {
		setBusyId(row.id);
		setError(null);
		try {
			const response = await authFetch(`/api/agent/actions/${encodeURIComponent(row.id)}/undo`, { method: "POST" });
			if (!response.ok) setError(await errorMessage(response, "The action could not be undone."));
		} catch {
			setError("The action could not be undone.");
		}
		setBusyId(null);
		reload();
		dispatchAgentSuggestionChanged({ mailboxId });
		window.dispatchEvent(new Event("kite:messages-changed"));
	}

	return (
		<div className="space-y-4" data-agent-activity={mailboxId}>
			{error && (
				<p role="alert" className="text-sm text-red-600">
					{error}
				</p>
			)}
			{value.state === "loading" && <p className="text-sm text-neutral-500">Loading…</p>}
			{value.state === "no-access" && (
				<p className="rounded-xl border border-dashed border-neutral-300 px-4 py-8 text-center text-sm text-neutral-500">
					Only people with full access to this mailbox can see Kite&apos;s activity.
				</p>
			)}
			{value.state === "error" && (
				<p role="alert" className="text-sm text-red-600">
					{value.message}
				</p>
			)}
			{value.state === "ready" && <ActivityLists data={value.data} busyId={busyId} onUndo={(row) => void undo(row)} />}
		</div>
	);
}

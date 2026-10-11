"use client";

import Link from "next/link";
import { useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { formatMessageListTimestamp } from "@/components/messages/utils";
import { dispatchAgentSuggestionChanged } from "@/hooks/message-realtime-utils";
import type { OpenSuggestion } from "@/hooks/open-suggestions-types";
import { useOpenSuggestions } from "@/hooks/use-open-suggestions";
import { authFetch } from "@/lib/auth/client";
import { FOR_YOU_KIND_LABELS, groupForYou, keepListedSelection } from "@/lib/agent/auto-read/for-you-utils";

async function dismissAll(ids: string[]): Promise<number> {
	let failed = 0;
	for (const id of ids) {
		const response = await authFetch(`/api/agent/suggestions/${encodeURIComponent(id)}/dismiss`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
		}).catch(() => null);
		if (!response?.ok) failed += 1;
	}
	return failed;
}

function ForYouEntry({
	suggestion,
	mailbox,
	selected,
	onToggle,
}: {
	suggestion: OpenSuggestion;
	mailbox: string | null;
	selected: boolean;
	onToggle: (id: string) => void;
}) {
	const subject = suggestion.message.subject || "(No subject)";
	return (
		<li className="flex items-start gap-3 px-4 py-3" data-for-you-entry={suggestion.id}>
			<Checkbox
				className="mt-1"
				checked={selected}
				onChange={() => onToggle(suggestion.id)}
				aria-label={`Select ${subject}`}
			/>
			<Link
				href={`/inbox/${encodeURIComponent(suggestion.messageId)}`}
				className="min-w-0 flex-1 rounded-md hover:text-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
			>
				<span className="block truncate text-sm font-medium text-neutral-900">{subject}</span>
				<span className="block truncate text-sm text-neutral-600">{suggestion.title}</span>
				<span className="block truncate text-xs text-neutral-500">
					{[suggestion.message.from, mailbox].filter(Boolean).join(" · ")}
				</span>
			</Link>
			<time dateTime={suggestion.createdAt} className="shrink-0 text-xs text-neutral-500">
				{formatMessageListTimestamp(suggestion.createdAt)}
			</time>
		</li>
	);
}

/** Open Kite suggestions from every full-access mailbox, grouped by kind, with bulk Dismiss. */
export function ForYouView() {
	const { loaded, suggestions, total, kindTotals, mailboxes, reload } = useOpenSuggestions();
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [dismissing, setDismissing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const listed = keepListedSelection(selected, suggestions);
	const groups = groupForYou(suggestions);
	const addresses = new Map(mailboxes.map((mailbox) => [mailbox.id, mailbox.address]));
	const showMailbox = mailboxes.length > 1;

	function toggle(id: string) {
		const next = new Set(listed);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		setSelected(next);
	}

	async function dismissSelected() {
		const ids = [...listed];
		setDismissing(true);
		setError(null);
		const failed = await dismissAll(ids);
		setDismissing(false);
		setSelected(new Set());
		if (failed > 0) setError(`${failed} of ${ids.length} suggestions could not be dismissed.`);
		reload();
		dispatchAgentSuggestionChanged();
		window.dispatchEvent(new Event("kite:messages-changed"));
	}

	return (
		<div className="mx-auto w-full max-w-3xl overflow-y-auto p-6 max-md:p-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div>
					<h1 className="flex items-center gap-2 text-2xl font-semibold text-neutral-900">
						<Sparkles aria-hidden className="h-5 w-5 text-blue-600" />
						For you
					</h1>
					<p className="mt-1 text-sm text-neutral-600">
						What Kite noticed in your mail. Nothing happens until you act.
					</p>
				</div>
				{suggestions.length > 0 && (
					<div className="flex items-center gap-3">
						<label className="flex items-center gap-2 text-sm text-neutral-700">
							<Checkbox
								checked={listed.size === suggestions.length}
								onChange={(event) =>
									setSelected(event.target.checked ? new Set(suggestions.map((item) => item.id)) : new Set())
								}
							/>
							Select all
						</label>
						<Button variant="outline" disabled={listed.size === 0 || dismissing} onClick={() => void dismissSelected()}>
							{dismissing ? "Dismissing..." : listed.size > 0 ? `Dismiss (${listed.size})` : "Dismiss"}
						</Button>
					</div>
				)}
			</div>
			{error && (
				<p role="alert" className="mt-4 text-sm text-red-600">
					{error}
				</p>
			)}
			{!loaded && <p className="mt-6 text-sm text-neutral-500">Loading…</p>}
			{total > suggestions.length && (
				<p data-for-you-truncated className="mt-4 text-sm text-neutral-600">
					Showing the newest {suggestions.length} of {total} suggestions.
				</p>
			)}
			{loaded && suggestions.length === 0 && (
				<p className="mt-6 rounded-lg border border-dashed border-neutral-200 px-4 py-6 text-center text-sm text-neutral-500">
					Nothing needs your attention right now.
				</p>
			)}
			{groups.map((group) => (
				<section
					key={group.kind}
					aria-labelledby={`for-you-${group.kind}`}
					className="mt-6 overflow-hidden rounded-xl border border-neutral-200 bg-white"
				>
					<h2
						id={`for-you-${group.kind}`}
						className="border-b border-neutral-200 bg-neutral-50 px-4 py-2 text-sm font-semibold text-neutral-800"
					>
						{FOR_YOU_KIND_LABELS[group.kind] ?? group.kind}{" "}
						<span className="font-normal text-neutral-500">({kindTotals[group.kind] ?? group.items.length})</span>
					</h2>
					<ul className="divide-y divide-neutral-200">
						{group.items.map((suggestion) => (
							<ForYouEntry
								key={suggestion.id}
								suggestion={suggestion}
								mailbox={showMailbox ? (addresses.get(suggestion.mailboxId) ?? null) : null}
								selected={listed.has(suggestion.id)}
								onToggle={toggle}
							/>
						))}
					</ul>
				</section>
			))}
		</div>
	);
}

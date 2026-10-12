"use client";

import { useState } from "react";
import { History } from "lucide-react";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { useOpenSuggestions } from "@/hooks/use-open-suggestions";
import { AgentActivity } from "./agent-activity";
import { pickActivityMailbox } from "./agent-activity-utils";

/** `/kite-activity`: Kite's audit log for one of the mailboxes the user has full access to. */
export function AgentActivityPage() {
	const { loaded, mailboxes } = useOpenSuggestions();
	const { selectedMailbox } = useSelectedMailbox();
	const [chosen, setChosen] = useState<string | null>(null);
	const mailboxId = pickActivityMailbox(mailboxes, chosen ?? selectedMailbox?.id);

	return (
		<div className="mx-auto w-full max-w-3xl space-y-4 overflow-y-auto p-6 max-md:p-4">
			<div className="flex flex-wrap items-end justify-between gap-3">
				<div>
					<h1 className="flex items-center gap-2 text-2xl font-semibold text-neutral-900">
						<History aria-hidden className="h-5 w-5 text-blue-600" />
						Activity
					</h1>
					<p className="mt-1 text-sm text-neutral-600">What Kite and people did with Kite&apos;s suggestions.</p>
				</div>
				{mailboxes.length > 1 && (
					<label className="text-sm text-neutral-700">
						Mailbox
						<select
							className="ml-2 rounded-lg border border-neutral-200 bg-white p-1.5 outline-none focus:border-blue-400"
							value={mailboxId ?? ""}
							onChange={(event) => setChosen(event.target.value)}
						>
							{mailboxes.map((mailbox) => (
								<option key={mailbox.id} value={mailbox.id}>
									{mailbox.address}
								</option>
							))}
						</select>
					</label>
				)}
			</div>
			{!loaded && <p className="text-sm text-neutral-500">Loading…</p>}
			{loaded && !mailboxId && (
				<p className="rounded-lg border border-dashed border-neutral-200 px-4 py-6 text-center text-sm text-neutral-500">
					Only people with full access to a mailbox can see Kite&apos;s activity.
				</p>
			)}
			{mailboxId && <AgentActivity key={mailboxId} mailboxId={mailboxId} />}
		</div>
	);
}

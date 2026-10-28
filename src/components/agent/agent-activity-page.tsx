"use client";

import { useState } from "react";
import { History } from "lucide-react";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { useOpenSuggestions } from "@/hooks/use-open-suggestions";
import { EmptyState, PanelHeader } from "@/components/ui/page";
import { Select } from "@/components/ui/select";
import { AgentActivity } from "./agent-activity";
import { pickActivityMailbox } from "./agent-activity-utils";

/** `/kite-activity`: Kite's audit log for one of the mailboxes the user has full access to. */
export function AgentActivityPage() {
	const { loaded, mailboxes } = useOpenSuggestions();
	const { selectedMailbox } = useSelectedMailbox();
	const [chosen, setChosen] = useState<string | null>(null);
	const mailboxId = pickActivityMailbox(mailboxes, chosen ?? selectedMailbox?.id);

	return (
		<div className="flex min-h-full flex-col">
			<PanelHeader
				icon={History}
				title="Activity"
				actions={
					mailboxes.length > 1 && (
						<label className="flex items-center gap-2 text-sm text-neutral-700">
							Mailbox
							<Select
								containerClassName="h-8"
								className="text-sm"
								value={mailboxId ?? ""}
								onChange={(event) => setChosen(event.target.value)}
							>
								{mailboxes.map((mailbox) => (
									<option key={mailbox.id} value={mailbox.id}>
										{mailbox.address}
									</option>
								))}
							</Select>
						</label>
					)
				}
			/>
			<div className="mx-auto w-full max-w-3xl space-y-4 p-6 max-md:p-4">
				<p className="text-sm text-neutral-500">What Kite and people did with Kite&apos;s suggestions.</p>
				{!loaded && <p className="text-sm text-neutral-500">Loading…</p>}
				{loaded && !mailboxId && (
					<EmptyState title="Only people with full access to a mailbox can see Kite's activity." />
				)}
				{mailboxId && <AgentActivity key={mailboxId} mailboxId={mailboxId} />}
			</div>
		</div>
	);
}

"use client";

import { useEffect, useState } from "react";
import { UserCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { MailboxOption } from "@/components/mailbox-provider";
import type { ScreenerDecision, ScreenerMessageStatus } from "@/lib/screener/screener-types";
import { SCREENING_STATUS } from "@/lib/screener/screener-utils";
import { decideScreenerSender, fetchScreenerMessageStatus } from "./screener-api";

/** Reader banner for a message whose sender waits for a Screener decision. */
export function ScreenerBanner({
	message,
	mailbox,
	alignWide,
}: {
	message: { id: string; direction: string; status: string };
	mailbox: MailboxOption | null | undefined;
	alignWide: boolean;
}) {
	const messageId = message.id;
	const [status, setStatus] = useState<{ messageId: string; value: ScreenerMessageStatus | null } | null>(null);
	const [pending, setPending] = useState(false);
	// Mailboxes without the Screener have nothing to look up, so the reader makes no extra request for them.
	const eligible =
		message.direction === "inbound" && (message.status === SCREENING_STATUS || mailbox?.screener?.enabled === true);

	useEffect(() => {
		if (!eligible) return;
		let cancelled = false;
		void fetchScreenerMessageStatus(messageId)
			.catch(() => null)
			.then((value) => {
				if (!cancelled) setStatus({ messageId, value });
			});
		return () => {
			cancelled = true;
		};
	}, [messageId, eligible]);

	const current = status?.messageId === messageId ? status.value : null;
	if (!current?.pending || !current.address || !current.mailboxId) return null;
	const { address, mailboxId } = current;

	async function decide(decision: ScreenerDecision) {
		setPending(true);
		const changed = await decideScreenerSender(mailboxId, address, decision);
		setPending(false);
		if (changed) setStatus({ messageId, value: { ...current!, pending: false } });
	}

	return (
		<div className={alignWide ? "px-3 sm:px-6 sm:pl-16" : "px-3 sm:px-6 sm:pl-10"}>
			<div
				role="region"
				aria-label="New sender"
				className="my-2 flex flex-wrap items-center gap-3 rounded-2xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-neutral-800"
			>
				<UserCheck className="h-4 w-4 shrink-0 text-blue-700" aria-hidden="true" />
				<p className="min-w-0 flex-1">
					<span className="font-medium">{address}</span> has not written to this mailbox before.{" "}
					{current.canManage
						? "Approve them to let their mail into the Inbox, or deny them to block it."
						: "Someone with full access to this mailbox can approve or deny them."}
				</p>
				{current.canManage && (
					<div className="flex gap-2">
						<Button type="button" size="sm" disabled={pending} onClick={() => void decide("approved")}>
							Approve
						</Button>
						<Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => void decide("denied")}>
							Deny
						</Button>
					</div>
				)}
			</div>
		</div>
	);
}

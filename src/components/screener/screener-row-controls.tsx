"use client";

import { useState } from "react";
import type { MouseEvent } from "react";
import clsx from "clsx";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import type { Message } from "@/hooks/types";
import { getEmailAddress } from "@/lib/email/address";
import type { ScreenerDecision } from "@/lib/screener/screener-types";
import { decideScreenerSender } from "./screener-api";

/** The "New sender" mark on a list row, with Approve and Deny for people with full access to the mailbox. */
export function ScreenerRowControls({ message, compact = false }: { message: Message; compact?: boolean }) {
	const { mailboxes } = useSelectedMailbox();
	const [pending, setPending] = useState(false);
	if (!message.screenerPending || !message.mailboxId) return null;
	const mailboxId = message.mailboxId;
	const canManage = mailboxes.find((mailbox) => mailbox.id === mailboxId)?.permission === "full_access";
	const address = getEmailAddress(message.fromAddr).toLowerCase();

	function decide(event: MouseEvent<HTMLButtonElement>, decision: ScreenerDecision) {
		event.preventDefault();
		event.stopPropagation();
		setPending(true);
		void decideScreenerSender(mailboxId, address, decision).finally(() => setPending(false));
	}

	return (
		<span className={clsx("relative z-10 inline-flex items-center gap-1.5 align-middle", compact ? "mt-1" : "mr-2")}>
			<span className="rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700">New sender</span>
			{canManage && (
				<>
					<button
						type="button"
						disabled={pending}
						onClick={(event) => decide(event, "approved")}
						aria-label={`Approve ${address}`}
						className="rounded-full border border-neutral-200 bg-white px-2 py-0.5 text-[11px] font-medium text-neutral-800 hover:border-blue-300 hover:text-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 disabled:opacity-50"
					>
						Approve
					</button>
					<button
						type="button"
						disabled={pending}
						onClick={(event) => decide(event, "denied")}
						aria-label={`Deny ${address}`}
						className="rounded-full border border-neutral-200 bg-white px-2 py-0.5 text-[11px] font-medium text-neutral-800 hover:border-red-300 hover:text-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 disabled:opacity-50"
					>
						Deny
					</button>
				</>
			)}
		</span>
	);
}

"use client";

import Link from "next/link";
import { Wallet } from "lucide-react";
import {
	COMMAND_CENTER_DETAIL_CLASS,
	COMMAND_CENTER_LINK_CLASS,
	COMMAND_CENTER_LINK_ROW_CLASS,
	COMMAND_CENTER_LIST_CLASS,
	CommandCenterCard,
	CommandCenterEmpty,
} from "@/components/command-center/command-center-card";
import { useCommandCenterCardQuery } from "@/components/command-center/use-card-query";
import type { SubscriptionList } from "@/components/finance/subscriptions-types";
import { viewerLocale, viewerToday } from "@/components/finance/use-subscriptions";
import type { ReadingPaneSlotContext } from "@/components/modules/client-registry-types";
import { WARNING_TEXT_CLASS } from "@/components/notice-styles";
import { authFetch } from "@/lib/auth/client";
import { renewalLines } from "./renewals-card-utils";

/** A failed payment's date in the warning text colour the notices use. */
const URGENT_CLASS = `font-medium ${WARNING_TEXT_CLASS}`;

/**
 * The command center's Money Watch card: the viewer's own subscriptions that renew, end a trial or failed a
 * payment this week, with a link to Subscriptions. It draws nothing until they are in, and nothing at all when
 * they cannot be read (Money Watch off, the database update not applied yet, an error). Only current rows are
 * fetched, and they are reused for a minute when the pane comes back after a message was closed.
 */
export function RenewalsCard(_context: ReadingPaneSlotContext) {
	const list = useCommandCenterCardQuery(["finance.renewals"], async () => {
		const response = await authFetch("/api/finance/subscriptions?status=current");
		if (!response.ok) throw new Error(`Subscriptions request failed (${response.status})`);
		const data = (await response.json()) as SubscriptionList;
		return data.migrationPending ? null : data;
	});

	if (!list) return null;
	const { lines, more } = renewalLines(list.subscriptions, viewerToday(), viewerLocale());
	return (
		<CommandCenterCard
			title="Money Watch"
			icon={Wallet}
			action={{ label: "Subscriptions", href: "/finance" }}
			testId="command-center-renewals"
		>
			{lines.length === 0 ? (
				<CommandCenterEmpty icon={Wallet} action={{ label: "Open Money Watch", href: "/finance" }}>
					Nothing renews this week.
				</CommandCenterEmpty>
			) : (
				<ul className={COMMAND_CENTER_LIST_CLASS}>
					{lines.map((line) => (
						<li key={line.id}>
							<Link
								href={line.href}
								className={COMMAND_CENTER_LINK_ROW_CLASS}
								data-renewal={line.urgent ? "failed" : "due"}
							>
								<span className={`w-16 shrink-0 whitespace-nowrap ${line.urgent ? URGENT_CLASS : "text-neutral-500"}`}>
									{line.when}
								</span>
								<span className="min-w-0 flex-1 truncate text-neutral-900">{line.what}</span>
								<span className={`max-w-[40%] truncate ${COMMAND_CENTER_DETAIL_CLASS}`}>{line.meta}</span>
							</Link>
						</li>
					))}
				</ul>
			)}
			{more > 0 && (
				<Link href="/finance" className={`mt-2 block w-fit px-2 ${COMMAND_CENTER_LINK_CLASS}`}>
					{more} more this week
				</Link>
			)}
		</CommandCenterCard>
	);
}

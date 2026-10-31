"use client";

import Link from "next/link";
import { COMMAND_CENTER_LINK_CLASS, CommandCenterCard } from "@/components/command-center/command-center-card";
import { useCommandCenterCardQuery } from "@/components/command-center/use-card-query";
import type { SubscriptionList } from "@/components/finance/subscriptions-types";
import { viewerLocale, viewerToday } from "@/components/finance/use-subscriptions";
import type { ReadingPaneSlotContext } from "@/components/modules/client-registry-types";
import { authFetch } from "@/lib/auth/client";
import { renewalLines } from "./renewals-card-utils";

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
			action={{ label: "Subscriptions", href: "/finance" }}
			testId="command-center-renewals"
		>
			{lines.length === 0 ? (
				<p className="py-1.5 text-sm text-neutral-700">Nothing renews this week.</p>
			) : (
				<ul className="divide-y divide-cc-border">
					{lines.map((line) => (
						<li key={line.id}>
							<Link
								href={line.href}
								className="group flex items-center gap-3 py-2 text-sm text-neutral-900 hover:text-cc-accent"
								data-renewal={line.urgent ? "failed" : "due"}
							>
								<span
									className={`w-16 shrink-0 whitespace-nowrap ${line.urgent ? "font-medium text-cc-warn-text" : "text-neutral-600"}`}
								>
									{line.when}
								</span>
								<span className="min-w-0 flex-1 truncate underline-offset-2 group-hover:underline">{line.what}</span>
								<span className="max-w-[40%] shrink-0 truncate text-xs text-neutral-600">{line.meta}</span>
							</Link>
						</li>
					))}
				</ul>
			)}
			{more > 0 && (
				<Link href="/finance" className={`mt-1 block w-fit ${COMMAND_CENTER_LINK_CLASS}`}>
					{more} more this week
				</Link>
			)}
		</CommandCenterCard>
	);
}
